'use strict';

const engines = require('../engines');

const _ = require('lodash');
const async = require('async');

module.exports = function(core) {

    // initialize available engines
    _.each(engines, function(engine/*, engine_name*/) {
        engine.initialize(core);
    });

    // register codexd middleware
    _.each(engines, function(engine/*, engine_name*/) {
        engine.add_pre_start_middleware('CS_PROC_OPTS', function(options, fn) {
            let application_name = options.application_name;
            let container = _.omit(options, ['application_name', 'start_args']);

            let env_vars = container.env_vars;
            env_vars.CS_PROC_OPTS = JSON.stringify(core.options);
            container.env_vars = env_vars;

            let myriad_key = [core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER);
            core.cluster.myriad.persistence.set(myriad_key, JSON.stringify(container), fn);
        });

        engine.add_pre_start_middleware('codexd', function(options, fn) {
            let application_name = options.application_name;
            let container = _.omit(options, ['application_name', 'start_args']);

            let volumes = _.groupBy(container.volumes, function(volume) {
                return volume.host;
            });

            let codexd_volumes_metadata = {};

            async.each(volumes.undefined || [], function(volume, fn) {
                let uuid = core.cluster.codexd.create_uuid();

                core.cluster.codexd.create_volume({
                    id: uuid
                }, function(err) {
                    if(err) {
                        return fn();
                    }

                    codexd_volumes_metadata[uuid] = volume.container;
                    return fn();
                });
            }, function(err) {
                if (err) { /* ignore */ }

                let codexd_volumes_inverse = _.invert(codexd_volumes_metadata);
                container.volumes = _.map(container.volumes, function(volume) {
                    if(volume.host == undefined && _.has(codexd_volumes_inverse, volume.container)) {
                        return {
                            host: [core.cluster.codexd.options.base_path, codexd_volumes_inverse[volume.container]].join('/'),
                            container: volume.container
                        };
                    } else {
                        return volume;
                    }
                });

                if(!_.has(container.tags, 'metadata')) {
                    container.tags.metadata = {};
                }

                if(!_.has(container.tags.metadata, 'codexd')) {
                    container.tags.metadata.codexd = {};
                }

                if(!_.has(container.tags.metadata.codexd, 'volumes')) {
                    container.tags.metadata.codexd.volumes = codexd_volumes_metadata;
                    _.merge(options, container);
                    core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER), JSON.stringify(container), function(err) {
                        if (err) { /* ignore */ }

                        return fn();
                    });
                } else {
                    let codexd_errs = [];

                    let host_volumes = core.cluster.codexd.get_volumes();

                    async.each(_.keys(container.tags.metadata.codexd.volumes), function(uuid, fn) {
                        if(!_.has(host_volumes, uuid)) {
                            core.cluster.codexd.get_snapshot(uuid, function(err) {
                                if(err) {
                                    codexd_errs.push(err);
                                } else {
                                    core.cluster.legiond.send({
                                        event: core.cluster.codexd.constants.REMOVE_SNAPSHOT,
                                        data: {
                                            id: uuid
                                        }
                                    });
                                }
                                return fn();
                            });
                        } else {
                            return fn();
                        }
                    }, function() {
                        container.tags.metadata.codexd.volumes = _.defaults(container.tags.metadata.codexd.volumes, codexd_volumes_metadata);
                        _.merge(options, container);
                        core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER), JSON.stringify(container), function(err) {
                            if (err) { /* ignore */ }
                            if(_.isEmpty(codexd_errs)) {
                                return fn();
                            } else {
                                return fn(_.head(codexd_errs));
                            }
                        });
                    });
                }
            });
        });
    });

    return {

        container: {
            start: function(configuration) {
                let container = configuration.container;
                container.application_name = configuration.application;

                if(_.has(container, 'engine') && _.has(engines, container.engine)) {
                    engines[container.engine].start(container);
                } else {
                    let error = new Error('Unsupported engine provided');
                    error.details = ['Engine', container.engine, 'not found!'].join(' ');
                    core.loggers['containership.scheduler'].log('error', error.details);
                    container.status = 'unloaded';
                    core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, container.application_name, container.id].join('::'), function(err) {
                        if(err) {
                            let error = new Error('Unable to set container status');
                            error.details = ['Could not set status for', container.application_name, 'container', container.id, "to 'unloaded'"].join(' ');
                            core.loggers['containership.scheduler'].log('error', error.details);
                        }
                    });
                }
            },

            stop: function(configuration) {
                engines[configuration.engine].stop(configuration);
            },

            reconcile: function(leader) {
                _.each(engines, function(engine, engine_name) {
                    engines[engine_name].reconcile(leader);
                });
            },

            add_pre_start_middleware: function(engine_name, middleware_name, fn) {
                if(_.has(engines, engine_name)) {
                    engines[engine_name].add_pre_start_middleware(middleware_name, fn);
                }
            },

            add_pre_pull_middleware: function(engine_name, middleware_name, fn) {
                if(_.has(engines, engine_name)) {
                    engines[engine_name].add_pre_pull_middleware(middleware_name, fn);
                }
            },

            set_start_arguments: function(engine_name, key, value) {
                if(_.has(engines, engine_name)) {
                    engines[engine_name].set_start_arguments(key, value);
                }
            }
        }

    };

};
