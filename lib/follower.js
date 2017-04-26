var _ = require('lodash');
var async = require('async');
var engines = require('../engines');
var fs = require('fs');
var mkdirp = require('mkdirp');

function logToContainer(core, containerId, mesg) {
    const basePath = process.env.CSHIP_LOG_PATH || '/var/log/containership'
    const directory = _.join([basePath, 'applications', 'containership-logs', containerId], '/');

    mkdirp(directory, (err) => {
        if(err) {
            core.loggers['containership.scheduler'].log('error', 'Error creating application log directory: ' + err);
        } else {
            const path = _.join([directory, 'stdout'], '/');

            fs.appendFile(path, mesg + '\n', (err) => {
                if(err) {
                    core.loggers['containership.scheduler'].log('error', 'Error logging to container: ' + err);
                }
            });
        }
    });
}

module.exports = function(core){

    // initialize available engines
    _.each(engines, function(engine, engine_name){
        engines[engine_name] = engine(core);
    });

    // register codexd middleware
    _.each(engines, function(engine, engine_name){
        engine.addPreStartMiddleware('USER_VARIABLES', function(options, fn){
            options.user_variables = {};
            var application_name = options.application_name;

            core.cluster.myriad.persistence.keys(core.constants.myriad.USER_VARIABLES, (err, variables) => {
                if(err) {
                    return fn(err);
                }

                async.each(variables, (variable_name, fn) => {
                    core.cluster.myriad.persistence.get(variable_name, (err, value) => {
                        if(err) {
                            return fn();
                        }

                        variable_name = _.last(variable_name.split(core.constants.myriad.DELIMITER))].join('_');
                        const name = `CS_USER_VARIABLE_${variable_name}`;
                        options.user_variables[name] = value;
                        return fn();
                    });
                }, fn);
            });
        });

        engine.addPreStartMiddleware('CS_PROC_OPTS', function(options, fn){
            var application_name = options.application_name;
            var container = _.omit(options, [
                'application_name',
                'start_args'
            ]);

            var env_vars = container.env_vars;

            env_vars.CS_PROC_OPTS = JSON.stringify(core.options);
            container.env_vars = env_vars;

            var myriad_key = [core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER);
            core.cluster.myriad.persistence.set(myriad_key, JSON.stringify(container), fn);
        });

        engine.addPreStartMiddleware('codexd', function(options, fn){
            var application_name = options.application_name;
            var container = _.omit(options, [
                'application_name',
                'start_args'
            ]);

            var volumes = _.groupBy(container.volumes, function(volume){
                return volume.host;
            });

            var codexd_volumes_metadata = {};

            async.each(volumes.undefined || [], function(volume, fn){
                var uuid = core.cluster.codexd.create_uuid();

                core.cluster.codexd.create_volume({
                    id: uuid
                }, function(err){
                    if(err)
                        return fn();

                    codexd_volumes_metadata[uuid] = volume.container;
                    return fn();
                });
            }, function(err){
                var codexd_volumes_inverse = _.invert(codexd_volumes_metadata);
                container.volumes = _.map(container.volumes, function(volume){
                    if(volume.host == undefined && _.has(codexd_volumes_inverse, volume.container)){
                        return {
                            host: [core.cluster.codexd.options.base_path, codexd_volumes_inverse[volume.container]].join('/'),
                            container: volume.container
                        }
                    }
                    else
                        return volume;
                });

                if(!_.has(container.tags, 'metadata'))
                    container.tags.metadata = {};

                if(!_.has(container.tags.metadata, 'codexd'))
                    container.tags.metadata.codexd = {};

                if(!_.has(container.tags.metadata.codexd, 'volumes')){
                    container.tags.metadata.codexd.volumes = codexd_volumes_metadata;
                    _.merge(options, container);
                    core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER), JSON.stringify(container), function(err){
                        return fn();
                    });
                }
                else{
                    var codexd_errs = [];

                    var host_volumes = core.cluster.codexd.get_volumes();

                    async.each(_.keys(container.tags.metadata.codexd.volumes), function(uuid, fn){
                        if(!_.has(host_volumes, uuid)){
                            core.cluster.codexd.get_snapshot(uuid, function(err){
                                if(err)
                                    codexd_errs.push(err);
                                else{
                                    core.cluster.legiond.send({
                                        event: core.cluster.codexd.constants.REMOVE_SNAPSHOT,
                                        data: {
                                          id: uuid
                                        }
                                    });
                                }
                                return fn();
                            });
                        }
                        else
                            return fn();
                    }, function(){
                        container.tags.metadata.codexd.volumes = _.defaults(container.tags.metadata.codexd.volumes, codexd_volumes_metadata);
                        _.merge(options, container);
                        core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER), JSON.stringify(container), function(err){
                            if(_.isEmpty(codexd_errs))
                                return fn();
                            else
                                return fn(_.head(codexd_errs));
                        });
                    });
                }
            });
        });
    });

    return {

        container: {
            start: function(configuration){
                var container = configuration.container;
                container.application_name = configuration.application;

                if(_.has(container, 'engine') && _.has(engines, container.engine)) {
                    engines[container.engine].start(container);
                    logToContainer(core, container.id, _.join(['Starting application', container.application_name, 'on container', container.id], ' '));
                } else {
                    var error = new Error('Unsupported engine provided');
                    error.details = ['Engine', container.engine, 'not found!'].join(' ');
                    core.loggers['containership.scheduler'].log('error', error.details);
                    containers.status = 'unloaded';
                    core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, container.application_name, container.id].join(core.constants.myriad.DELIMITER), function(err){
                        if(err){
                            var error = new Error('Unable to set container status');
                            error.details = ['Could not set status for', container.application_name, 'container', container.id, "to 'unloaded'"].join(' ');
                            core.loggers['containership.scheduler'].log('error', error.details);
                        }
                    });
                }
            },

            stop: function(configuration){
                engines[configuration.engine].stop(configuration);
                logToContainer(core, configuration.container_id, _.join(['Stopping application:', configuration.application, 'on container', configuration.container_id], ' '));
            },

            reconcile: function(leader){
                _.each(engines, function(engine, engine_name){
                    engines[engine_name].reconcile(leader);
                });
            },

            add_pre_start_middleware: function(engine_name, middleware_name, fn){
                if(_.has(engines, engine_name))
                    engines[engine_name].addPreStartMiddleware(middleware_name, fn);
            },

            add_pre_pull_middleware: function(engine_name, middleware_name, fn){
                if(_.has(engines, engine_name))
                    engines[engine_name].addPrePullMiddleware(middleware_name, fn);
            },

            set_start_arguments: function(engine_name, key, value){
                if(_.has(engines, engine_name))
                    engines[engine_name].setStartArgument(key, value);
            }
        }

    }

}
