'use strict';

const _ = require('lodash');
const async = require('async');
const Docker = require('dockerode');
const flat = require('flat');
const fs = require('fs');
const mkdirp = require('mkdirp');
const shellQuote = require('shell-quote');

const Engine = require('./engine');
const Utils = require('../lib/utils');

const docker = new Docker();

class DockerEngine extends Engine {
    static universalOptionsToDocker(options) {

        // If no container_port is provided, default to host_port.
        options = _.defaultsDeep(options, {
            container_port: options.host_port
        });

        let keys = _.sortBy(_.keys(options.env_vars), function(key){
            return -key.length;
        });

        let mapping = {
            'cpus':             (v) => ({'HostConfig': {'CpuShares': Math.floor(v * 1024)}}),
            'memory':           (v) => ({'HostConfig': {'Memory': v * 1024 * 1024}}),
            'image':            (v) => ({'Image':v}),
            'privileged':       (v) => ({'HostConfig': {'Privileged': v}}),
            'network_mode':     (v) => ({'HostConfig': {'NetworkMode': v}}),
            'application_name': (v) => ({'name': `${v}-${options.id}`}),
            'command':          (v) => !_.isEmpty(v) ? {'Cmd': shellQuote.parse(v)} : {},

            'env_vars': (v) => ({
                'Env': _.map(_.merge(v, {
                    PORT: options.container_port,
                }), (v,k) => {
                    v = v.toString();
                    _.forEach(keys, (_key) => {
                        if(v.indexOf(`$${_key}`) !== -1) {
                            v = v.replace(`$${_key}`, options.env_vars[_key]);
                        }
                    });

                    return _.join([k,v], '=');
                })
            }),

            'volumes': (v) => ({
                'HostConfig': {
                    'Binds': _.map(v, (volume) => {
                        return _.join(volume.propogation ?
                            [volume.host, volume.container, volume.propogation]:
                            [volume.host, volume.container], ':')
                    }),
                    'Volumes': _.merge.apply(null, _.map(v, (volume) => {
                        const vol = {};
                        vol[volume.container] = {}
                        return vol;
                    }))
                }
            }),

            'host_port': (v) => {
                const portBindings = {};
                const exposedPorts = {};
                const container_port = _.includes(options.container_port, '/') ? options.container_port : `${options.container_port}/tcp`;
                portBindings[container_port] = [{
                    'HostPort': v.toString()
                }];
                exposedPorts[container_port] = {};

                return {
                    'HostConfig': {
                        'PortBindings': portBindings
                    },
                    'ExposedPorts': exposedPorts
                }
            }

        };

        mapping = _.merge.apply(null, _.map(options, (v,k) => (mapping[k] ? mapping[k](v): null)));

        // merge in additional start aguments to the options mapping
        // start argument values may have been set as functions
        // expecting to be invoked with the existing options
        let start_args = flat.flatten(options.start_args);
        start_args = _.reduce(start_args, (accumulator, value, key) => {
            accumulator[key] = Utils.safeJsonParse(typeof value === 'function' ? value(mapping) : value);
            return accumulator;
        }, {});
        start_args = flat.unflatten(start_args);
        mapping = _.merge(mapping, start_args);

        return mapping;
    }

    initialize() {
        docker.version((err, info) => {
            if(err) {
                this.log('error', `Error getting docker version: ${err}`);
            } else {
                const attributes = this.core.cluster.legiond.get_attributes();
                const tags = _.merge({
                    metadata: {
                        engines: {
                            docker: {
                                client_version: info.Version,
                                api_version: info.ApiVersion,
                                go_version: info.GoVersion
                            }
                        }
                    }
                }, attributes.tags);

                this.core.cluster.legiond.set_attributes({
                    tags: tags
                });
            }
        });

        setInterval(() => {
            this.runDockerCustodian();
        }, 6 * 1000 * 60 * 60);

    }

    runDockerCustodian() {
        this.log('info', 'Running Docker-Custodian.');

        docker.pull('yelp/docker-custodian', (err, stream) => {
            if (err) {
                this.log('warn', `Docker-Custodian failed to pull ${err}`);
            }

            const onFinished = (err, output) => {
                if (err) {
                    this.log('warn', `Docker-Custodian failed to pull ${err}`);
                }

                this.log('info', `Docker-Custodian pulled well`);
                const run_opts = [
                    'dcgc',
                    '--max-container-age',
                    `${this.core.options['max-docker-container-age']}hours`,
                    '--max-image-age',
                    `${this.core.options['max-docker-image-age']}hours`
                ];

                docker.run('yelp/docker-custodian', run_opts, process.stdout, {
                    Binds: ['/var/run/docker.sock:/var/run/docker.sock']
                }, (err, data, container) => {
                    if(err) {
                        this.log('warn', `Docker-Custodian failed to cleanup old images and containers ${err}`);
                    } else {
                        this.log('info', 'Docker-Custodian ran successfully.');
                    }

                });
            }

            docker.modem.followProgress(stream, onFinished);
        });

    }

    log(level, mesg) {
        this.core.loggers['containership.scheduler'].log(level, mesg);
    }

    pull(image, auths, cb) {
        async.eachSeries(auths, (auth, fn) => {
            const index = auths.indexOf(auth);
            //For each auth, try to pull
            docker.pull(image, auth, (err, stream) => {
                if(err) {
                    if(index < _.size(auths) - 1) {
                        // don't error because we need to continue checking the rest of the registries
                        return fn();
                    } else {
                        return fn(err);
                    }
                }

                docker.modem.followProgress(stream, fn);

            });

        }, (err) => {
            if(err) {
                this.log('warn', `Failed to pull docker image: ${err}`);
                return cb(err);
            }

            return cb();
        });
    }

    cleanupContainer(container, id, applicationName, respawn) {
        // if this.containers does not contain the container id, this means the container was
        // manually stopped and it has already been removed in the stop(...) function
        if(!_.has(this.containers, id)) {
            return;
        }

        delete this.containers[id];

        container.remove((err) => {
            if(err) {
                this.log('error', `Error removing container ${id} on cleanup: ${err}`);
            } else {
                this.log('info', `Successfully removed container ${id} on cleanup.`);
            }
        });

        Utils.setContainerMyriadStateUnloaded(this.core, _.merge({
            container_id: id,
            application_name: applicationName
        }, !_.isUndefined(respawn) ? {respawn} : {}));
    }

    trackContainer(container, id, applicationName, respawn) {
        this.containers[id] = container;

        container.wait(() => this.cleanupContainer(container, id, applicationName, respawn));

        const logDir =  `${this.core.options['base-log-dir']}/applications/${applicationName}/${id}`;

        return mkdirp(logDir, (err) => {
            if(err) {
                this.log('error', `Error creating log directory ${logDir}: ${err}`);
                return;
            }

            container.attach({stream: true, stdout: true, stderr: true}, (err, stream) => {
                if(err) {
                    this.log('error', `Error attaching to tracked container ${id}: ${err}`);
                } else {
                    const stdout = !err ? fs.createWriteStream(`${logDir}/stdout`) : process.stdout;
                    const stderr = !err ? fs.createWriteStream(`${logDir}/stderr`) : process.stderr;
                    container.modem.demuxStream(stream, stdout, stderr);
                }
            });
        });
    }

    start(options) {

        const withOptions = (fn) => _.partial(fn, options);
        const prePullMiddleware = _.mapValues(this.middleware.prePull, withOptions);
        const preStartMiddleware = _.mapValues(this.middleware.preStart, withOptions);

        const attrs = this.core.cluster.legiond.get_attributes();
        const unloadContainer = () => {
            Utils.setContainerMyriadStateUnloaded(this.core, {
                container_id: options.id,
                application_name: options.application_name
            });
        };

        async.parallel(prePullMiddleware, (err) => {
            if(err) {
                unloadContainer();
            } else {
                const auths = options.auth || [{}];
                delete options.auth;

                this.pull(options.image, auths, (err) => {
                    if(err) {
                        this.log('warn', `Failed to pull ${options.image}`);
                        this.log('error', err.message);
                        unloadContainer();
                    } else {
                        options.start_args = this.startArgs;

                        async.parallel(preStartMiddleware, (err) => {
                            if(err) {
                                this.log('warn', 'Failed to execute pre-start middleware');
                                this.log('error', err.message);
                                unloadContainer();
                            } else {
                                const dockerOpts = DockerEngine.universalOptionsToDocker(options);
                                this.log('verbose', `Creating docker container with with: ${JSON.stringify(dockerOpts)}`);
                                docker.createContainer(dockerOpts, (err, container) => {
                                    if(!err) {
                                        container.start((err, data) => {
                                            if(!err) {
                                                //Begin tracking
                                                this.trackContainer(container, options.id, options.application_name, options.respawn);

                                                this.log('info', `Loading ${options.application_name} container: ${options.id}`);
                                                Utils.updateContainerMyriadState(this.core, {
                                                    application_name: options.application_name,
                                                    container_id: options.id,
                                                    host_port: options.host_port,
                                                    status: 'loaded'
                                                }, (err) => {
                                                    if(err) {
                                                        this.log('warn', `Failed to set loaded state on ${options.application_name} container ${options.id}`);
                                                        this.log('error', err.message);

                                                        this.containers[options.id].stop((err) => {
                                                            if (err) {
                                                                return this.log('error', `Failed to stop container ${options.id}: ${err}`);
                                                            }

                                                            unloadContainer();
                                                            this.log('info', `Sucessfully stopped container ${options.id}`);
                                                        });
                                                    }
                                                });
                                            } else {
                                                this.log('error', `Error starting container ${err}.`);
                                                unloadContainer();
                                            }
                                        });
                                    } else {
                                        this.log('error', `Error creating container ${err}.`);
                                        unloadContainer();
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });

    }

    stop(options) {
        if(_.has(this.containers, options.container_id)) {
            const container = this.containers[options.container_id];
            delete this.containers[options.container_id];

            container.stop((err) => {
                if (err) {
                    return this.log('error', `Failed to stop container ${options.container_id}: ${err}`);
                }

                Utils.deleteContainerMyriadState(this.core, {
                    application_name: options.application,
                    container_id: options.container_id
                }, (err) => {
                    if (err) {
                        return this.log('error', `Failed to stop container ${options.container_id}: ${err}`);
                    }

                    this.log('info', `Sucessfully stopped container ${options.container_id}`);
                });
            });
        } else {
            this.log('error', `Attempted to stop an untracked container ${options.container_id}.`);
        }
    }

    reconcile(callback) {

        this.log('info', 'Started Reconciliation.');
        //List running containers.
        docker.listContainers({all: true}, (err, containersOnHost) => {
            containersOnHost = containersOnHost || [];
            const attrs = this.core.cluster.legiond.get_attributes();

            async.each(containersOnHost, (containerState, fn) => {
                //Remove the preceeding / from the container name.
                const name = containerState.Names[0].slice(1);

                //Make sure this is a cs managed container.
                if(!name.match(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/g)) {
                    return fn();
                }

                const parts = name.split('-');
                const applicationName = _.take(parts, parts.length - 5).join('-');
                const containerId = _.takeRight(parts, 5).join('-');

                const container = docker.getContainer(containerState.Id);

                container.inspect((err, info) => {
                    //The container is dead.
                    if(!info.State.Running && !info.State.Restarting) {
                        container.remove((err) => {
                            if(!err) {
                                this.log('verbose', `Cleaned up dead ${applicationName} container: ${containerId}`);
                            } else {
                                this.log('error', `Error cleaning up dead ${applicationName} container: ${containerId}: ${err}`);
                            }

                            return fn();
                        });
                      //There is a live container running on the host.
                    } else {
                        //Check to see if there's a record of it in myriad.
                        this.core.cluster.myriad.persistence.get(_.join([this.core.constants.myriad.CONTAINERS_PREFIX, applicationName, containerId], this.core.constants.myriad.DELIMITER), {local: false}, (err, containerConfig) => {
                            //There's no record of this container, so remove it.
                            if(err) {
                                container.stop((err) => {
                                    container.remove({force: true}, (err) => {
                                        if(!err) {
                                            this.log('verbose', `Cleaned up untracked ${applicationName} container: ${containerId}`);
                                        } else {
                                            this.log('error', `Error cleaning up untracked ${applicationName} container: ${containerId}: ${err}`);
                                        }

                                        return fn();
                                    });
                                });
                              //There is a record,
                            } else {
                                containerConfig = JSON.parse(containerConfig);

                                // A Helper fn to reconcile the myriad state with the running container.
                                const alignMyriadWithContainer = (fn) => {

                                    var hostPort, containerPort;

                                    if(info.HostConfig.NetworkMode === 'bridge') {
                                        _.each(info.HostConfig.PortBindings, (bindings, binding) => {
                                            hostPort = bindings[0].HostPort;
                                            binding = binding.split('/')[0];
                                            if(binding != hostPort) {
                                                containerPort = binding;
                                            }
                                        });
                                    } else {
                                        _.each(info.Config.Env, (envVar) => {
                                            if(envVar.indexOf('PORT=') === 0) {
                                                hostPort = envVar.split('=')[1];
                                            }
                                        });
                                    }

                                    const newConfig = _.merge(containerConfig, {
                                        application_name: applicationName,
                                        container_id: containerId,
                                        status: 'loaded',
                                        host: attrs.id,
                                        start_time: new Date(info.Created).valueOf(),
                                        host_port: hostPort,
                                        container_port: containerPort,
                                        engine: 'docker'
                                    });

                                    this.log('info', `Reconciled running ${applicationName} container ${containerId}`);

                                    Utils.updateContainerMyriadState(this.core, newConfig, (err) => {
                                        if(err) {
                                            this.log('error', `Error setting myriad state during reconcile for ${containerId}: ${err}`);
                                        }
                                        return fn();
                                    });

                                }

                                //it's not being tracked
                                if(!_.has(this.containers, containerId)) {
                                    //Check that the container belongs on this host.
                                    if(!containerConfig.host || containerConfig.host === attrs.id) {
                                        //Track it
                                        this.trackContainer(container, containerId, applicationName);
                                        //And then update it's state
                                        return alignMyriadWithContainer(fn);
                                    } else {
                                        // It is not being tracked but belongs elsewhere anyway
                                        // so stop the local instance
                                        container.stop((err) => {
                                            if(!err) {
                                                this.log('info', `Stopped ${applicationName} on container ${containerId} because it's been moved to host ${containerConfig.host}`);
                                            } else {
                                                this.log('info', `Error stopping moved ${applicationName} on container ${containerId}.`);
                                            }
                                            return fn();
                                        });
                                    }

                                } else { //It is being tracked so update it's state and return
                                    return alignMyriadWithContainer(fn);
                                }
                            }

                        });
                    }
                });
            }, () => {
                this.log('info', 'Finished Reconciliation.');
                if (_.isFunction(callback)) { callback(); }
            });
        });
    }

}

module.exports = DockerEngine;
