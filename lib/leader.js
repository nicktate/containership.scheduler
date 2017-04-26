'use strict';

var _ = require("lodash");
var async = require("async");
var child_process = require('child_process');
var constants = require('containership.core.constants');
var flat = require("flat");

var constraints = require([__dirname, "constraints"].join("/"));

var workers = {};
module.exports = function(core){

    return {

        container: {

            harmonize: function(fn){
                var self = this;

                core.cluster.myriad.persistence.keys(core.constants.myriad.APPLICATIONS, function(err, applications){
                    if(err)
                        return fn();

                    async.each(applications, function(application_name, fn){
                        core.cluster.myriad.persistence.get(application_name, function(err, application){
                            application_name = _.last(application_name.split("::"));

                            try{
                                application = JSON.parse(application);
                            }
                            catch(err){
                                return fn(err);
                            }

                            async.each(_.keys(application.tags.constraints), function(constraint, fn){
                                constraints.list[constraint].harmonize(core, {
                                    application: application,
                                    application_name: application_name
                                }, fn);
                            }, function(){
                                core.applications.get_containers(application_name, function(err, containers){
                                    async.each(containers, function(container, fn){
                                        // if this container does not have an ID, we need to remove the container
                                        // state from myriad. Let it continue, it will be assigned an ID in the
                                        // core.applications.deploy function when it comes back null later on but
                                        // since its state is removed, it should prevent from container loop happening
                                        // on future harmonizes
                                        if (!container.id) {
                                            var badContainerId = [core.constants.myriad.CONTAINERS_PREFIX, application_name, ''].join(core.constants.myriad.DELIMITER);

                                            return core.cluster.myriad.persistence.delete(badContainerId, function(err) {
                                                if (err) {
                                                    core.loggers["containership.scheduler"].log("error", ["Failed to remove:", badContainerId].join(" "));
                                                    core.loggers["containership.scheduler"].log("error", err && err.message);
                                                }

                                                if(container.status === "loaded" && _.isNull(container.host)) {
                                                    core.applications.unload_containers(application_name, fn);
                                                } else {
                                                    return fn();
                                                }
                                            });
                                        } else {
                                            if(container.status === "loaded" && _.isNull(container.host)) {
                                                core.applications.unload_containers(application_name, fn);
                                            } else {
                                                return fn();
                                            }
                                        }
                                    }, function(){
                                        containers = _.groupBy(containers, "status");
                                        if(_.has(containers, "unloaded")){
                                            core.loggers["containership.scheduler"].log("info", ["Attempting to replace", containers.unloaded.length, "containers for", application.id].join(" "));
                                            async.each(containers.unloaded, function(container, fn){
                                                container = _.omit(container, ["start_time", "host"]);

                                                core.applications.deploy_container(application.id, container, function(err){
                                                    if(err)
                                                        core.loggers["containership.scheduler"].log("error", err.message);

                                                    return fn();
                                                });
                                            }, fn);
                                        }
                                        else
                                            return fn();
                                    });
                                });
                            });
                        });
                    }, fn);
                });
            },

            deploy: function(application_name, container, fn){
                var place_container = function(container, fn){
                    var cid = [application_name, container.id].join("-");

                    // get available hosts
                    var available_hosts = core.cluster.legiond.get_peers();
                    available_hosts.push(core.cluster.legiond.get_attributes());

                    var resources = {
                        cpus: parseFloat(container.cpus),
                        memory: _.parseInt(container.memory)
                    }

                    filter.by_mode(available_hosts, function(err, hosts){
                        if(err){
                            core.loggers["containership.scheduler"].log("debug", [err.message, cid].join(" "));
                            return fn();
                        }

                        filter.by_tag(hosts, _.cloneDeep(container.tags), function(err, hosts){
                            if(err){
                                core.loggers["containership.scheduler"].log("debug", [err.message, cid].join(" "));
                                return fn();
                            }

                            filter.by_vacancy(hosts, resources, function(err, hosts){
                                if(err){
                                    core.loggers["containership.scheduler"].log("debug", [err.message, cid].join(" "));
                                    return fn();
                                }

                                filter.by_constraints(hosts, function(err, hosts){
                                    if(err){
                                        core.loggers["containership.scheduler"].log("debug", [err.message, cid].join(" "));
                                        return fn();
                                    }
                                    return fn(null, _.sample(hosts));
                                });

                            });
                        });
                    });

                }

                var filter = {
                    // get hosts running in follower mode
                    by_mode: function(filtered_hosts, fn){
                        var hosts = _.filter(filtered_hosts, function(host){
                            return host.mode == "follower";
                        });

                        if(_.isEmpty(hosts))
                            return fn(new Error("No follower nodes detected when deploying"));
                        else
                            return fn(null, hosts);
                    },

                    // filter hosts by tag
                    by_tag: function(filtered_hosts, tags, fn){
                        delete tags.constraints;
                        delete tags.metadata;
                        tags = flat.flatten(tags);

                        var hosts = _.filter(filtered_hosts, function(host){
                            var matched = 0;
                            host.tags = flat.flatten(host.tags);
                            _.each(tags, function(tag_value, tag_name){
                                if(_.has(host.tags, tag_name) && host.tags[tag_name] == tag_value)
                                    matched++;
                            });

                            return matched == _.keys(tags).length;
                        });

                        if(_.isEmpty(hosts))
                            return fn(new Error("No follower nodes met the given tag criteria when deploying"));
                        else
                            return fn(null, hosts);
                    },

                    // filter hosts by vacancy
                    by_vacancy: function(filtered_hosts, resources, fn){
                        var overhead = 32;
                        var hosts = {};

                        _.each(filtered_hosts, function(host){
                            hosts[host.id] = host;
                            hosts[host.id].available_cpus = host.cpus;
                            hosts[host.id].available_memory = host.memory;
                        });

                        core.cluster.myriad.persistence.keys([core.constants.myriad.CONTAINERS_PREFIX, "*", "*"].join("::"), function(err, containers){
                            if(err)
                                return fn(new Error("No follower nodes had sufficient resources when deploying"));

                            async.each(containers, function(container_name, fn){
                                core.cluster.myriad.persistence.get(container_name, function(err, container){
                                    if(err)
                                        return fn();

                                    try{
                                        container = JSON.parse(container);
                                        if(_.includes(_.keys(hosts), container.host)){
                                            hosts[container.host].available_cpus -= parseFloat(container.cpus);
                                            hosts[container.host].available_memory -= (_.parseInt(container.memory) + overhead) * (1024 * 1024);
                                        }
                                    }
                                    catch(err){}
                                    return fn();
                                });
                            }, function(){
                                var hosts = _.filter(filtered_hosts, function(host){
                                    var available_cpus = host.available_cpus.toFixed(2);
                                    delete host.available_cpus;
                                    var available_memory = host.available_memory / (1024 * 1024);
                                    delete host.available_memory;
                                    available_memory -= overhead;
                                    return (available_memory - resources.memory >= 0) && (available_cpus - resources.cpus >= 0);
                                });

                                if(_.isEmpty(hosts))
                                    return fn(new Error("No follower nodes had sufficient resources when deploying"));
                                else
                                    return fn(null, hosts);
                            });
                        });
                    },

                    // filter hosts by constraints
                    by_constraints: function(filtered_hosts, fn){
                        constraints.enforce(core, {
                            available_hosts: filtered_hosts,
                            container: container,
                            application_name: application_name
                        }, function(err, hosts){
                            if(err)
                                return fn(err);
                            else if(_.isEmpty(hosts))
                                return fn(new Error("Could not meet constraints when deploying"));
                            else
                                return fn(null, hosts);
                        });
                    }
                }

                var get_host_port = function(host, fn){
                    core.cluster.myriad.persistence.keys(core.constants.myriad.APPLICATIONS, function(err, application_names){
                        if(err)
                            return fn();

                        async.map(application_names, function(application_name, fn){
                            application_name = _.last(application_name.split("::"));
                            core.applications.get_containers(application_name, fn);
                        }, function(err, containers){
                            if(err)
                                return fn(err);

                            containers = _.flatten(containers);

                            var containers_on_host = _.filter(containers, function(container){
                                return container.host == host.id;
                            });

                            var host_port;
                            var utilized_ports = _.map(containers_on_host, "host_port");

                            if(container.network_mode == "host" && _.has(container, "container_port")){
                                if(_.includes(utilized_ports, container.container_port))
                                    return fn(new Error("Requested port already in use"));
                                else{
                                    return fn(null, {
                                        host: host,
                                        host_port: container.container_port
                                    });
                                }
                            }

                            if(_.has(container, "host_port") && !_.isNull(container.host_port) && !_.isUndefined(container.host_port))
                                host_port = _.parseInt(container.host_port);

                            if(_.isUndefined(host_port)){
                                if(containers_on_host.length >= (core.scheduler.options.container.max_port - core.scheduler.options.container.min_port))
                                    return fn(new Error("No ports left to allocate on desired host"));

                                host_port = _.random(core.scheduler.options.container.min_port, core.scheduler.options.container.max_port);
                            }
                            else if(host_port < core.scheduler.options.container.min_port || host_port > core.scheduler.options.container.max_port)
                                return fn(new Error("Invalid port specified"));
                            else if(!_.includes(utilized_ports, host_port)){
                                return fn(null, {
                                    host: host,
                                    host_port: host_port
                                });
                            }
                            while(_.includes(utilized_ports, host_port))
                                host_port = _.random(core.scheduler.options.container.min_port, core.scheduler.options.container.max_port);

                            return fn(null, {
                                host: host,
                                host_port: host_port
                            });
                        });
                    });
                }

                var env_vars = {
                    clear_defaults: function(){
                        _.each(container.env_vars, function(value, name){
                            if(name.indexOf("CS_") == 0)
                                delete container.env_vars[name];
                        });
                    },

                    set_defaults: function(host, fn){

                        _.defaults(container.env_vars, {
                            CS_CONTAINER_ID: container.id,
                            CS_APPLICATION: application_name,
                            CS_CLUSTER_ID: core.cluster_id,
                            CS_FOLLOWER_HOSTNAME: host.host_name
                        });

                        async.series([
                            function(fn){
                                core.cluster.myriad.persistence.keys(core.constants.myriad.AUTOGENERATED_VARIABLES, function(err, auto_variables){
                                    async.each(auto_variables, function(auto_variable, fn){
                                        core.cluster.myriad.persistence.get(auto_variable, function(err, value){
                                            if(err){
                                                return fn();
                                            }

                                            const variable_name = _.last(auto_variable.split(core.constants.myriad.DELIMITER));
                                            container.env_vars[variable_name] = value;
                                            return fn();
                                        });
                                    }, fn);
                                });
                            },

                            function(fn){
                                core.cluster.myriad.persistence.keys(core.constants.myriad.USER_VARIABLES, function(err, variables){
                                    async.each(variables, function(variable_name, fn){
                                        core.cluster.myriad.persistence.get(variable_name, function(err, value){
                                            if(err) {
                                                return fn();
                                            }

                                            variable_name = _.last(variable_name.split(core.constants.myriad.DELIMITER));
                                            if(_.includes(container.env_vars, variable_name)) {
                                                var name = ["CS", "MYRIAD", variable_name.toUpperCase()].join("_");
                                                container.env_vars[name] = value;
                                            }

                                            return fn();
                                        });
                                    }, fn);
                                });
                            }
                        ], fn);
                    }
                }

                // check if application should be deployed to certain host
                if(container.host != null){
                    env_vars.clear_defaults();
                    var hosts = _.keyBy(core.cluster.legiond.get_peers(), "id");
                    var host = hosts[container.host];
                    env_vars.set_defaults(host, function(){
                        return get_host_port(host, fn);
                    });
                }

                // get a random host
                else{
                    env_vars.clear_defaults();
                    place_container(container, function(err, host){
                        if(err && err.fatal)
                            return fn(err);
                        else if(_.isUndefined(host))
                            return fn();
                        else{
                            env_vars.set_defaults(host, function(){
                                return get_host_port(host, fn);
                            });
                        }
                    });
                }
            }
        },

        application: {

            get_loadbalancer_port: function(port, fn){
                if(!_.isUndefined(port))
                    port = _.parseInt(port);

                core.cluster.myriad.persistence.keys(core.constants.myriad.APPLICATIONS, function(err, application_names){
                    async.map(application_names, function(application_name, fn){
                        core.cluster.myriad.persistence.get(application_name, function(err, application){
                            try{
                                return fn(null, JSON.parse(application).discovery_port)
                            }
                            catch(err){
                                return fn(err);
                            }
                        });
                    }, function(err, ports){
                        if(_.isUndefined(port)){
                            if(ports.length >= (core.scheduler.options.loadbalancer.max_port - core.scheduler.options.loadbalancer.min_port))
                                return fn(new Error("No ports left to allocate"));

                            port = _.random(core.scheduler.options.loadbalancer.min_port, core.scheduler.options.loadbalancer.max_port);
                        }
                        else if(port < core.scheduler.options.loadbalancer.min_port || port > core.scheduler.options.loadbalancer.max_port)
                            return fn(new Error("Invalid port specified"));

                        while(_.includes(ports, port))
                            port = _.random(core.scheduler.options.loadbalancer.min_port, core.scheduler.options.loadbalancer.max_port);

                        return fn(null, port);
                    });
                });
            },

            remove_containers: function(application_name, num_containers, fn){
                var all_containers = [];
                core.cluster.myriad.persistence.keys([core.constants.myriad.CONTAINERS_PREFIX, application_name, "*"].join("::"), function(err, containers){
                    async.each(containers, function(container_id, fn){
                        core.cluster.myriad.persistence.get(container_id, function(err, container){
                            try{
                                container = JSON.parse(container);
                                all_containers.push(container);
                            }
                            catch(err){}
                            return fn();
                        });
                    }, function(err){
                        if(all_containers.length <= num_containers)
                            return fn(null, _.map(all_containers, "id"));
                        else{
                            core.cluster.myriad.persistence.get([core.constants.myriad.APPLICATION_PREFIX, application_name].join(core.constants.myriad.DELIMITER), function(err, application){
                                if(err)
                                    return fn(err);

                                try{
                                    application = JSON.parse(application);
                                }
                                catch(err){
                                    return fn(err);
                                }

                                constraints.enforce_remove(core, {
                                    num_containers: num_containers,
                                    total_containers: all_containers.length,
                                    available_containers: all_containers,
                                    application: application
                                }, function(err, available_containers){
                                    if(err)
                                        return fn(err);
                                    else{
                                        if(available_containers.length > num_containers){
                                            var available_containers_by_status = _.defaults(_.groupBy(available_containers, "status"), {
                                                loaded: [],
                                                loading: [],
                                                unloaded: []
                                            });

                                            available_containers = _.take(_.flatten([
                                                available_containers_by_status.unloaded,
                                                available_containers_by_status.loading,
                                                available_containers_by_status.loaded
                                            ]), num_containers);
                                        }

                                        return fn(err, _.map(available_containers, "id"));
                                    }
                                });
                            });
                        }
                    });
                });
            },

            stop_all_health_checks: function() {
                _.each(workers, function(child) {
                    child.kill();
                });
                workers = {};
            },

            start_all_health_checks: function(fn) {
                return core.cluster.myriad.persistence.keys(constants.myriad.APPLICATIONS, function(err, applications) {
                    if(err) {
                        return fn && fn(err);
                    }

                    async.each(applications, function(application, fn) {
                        core.scheduler.leader.application.start_health_check(_.last(application.split(constants.myriad.DELIMITER)), (err) => {
                            if(err) {
                                return fn && fn(err);
                            }

                            return fn && fn();
                        });
                    }, fn);
                });
            },

            stop_health_check: function(application_name) {
                var child = workers[application_name];
                if(child) {
                    delete workers[application_name];
                    child.kill();
                }
            },

            start_health_check: function(application_name, fn) {
                if(!core.cluster.praetor.is_controlling_leader()) {
                    return fn && fn(new Error('You can not start health checks on a host that is not the controlling leader.'));
                }

                var legiond_attributes = core.cluster.legiond.get_attributes();
                var address = legiond_attributes.address;
                var legiond_scope = core.options['legiond-scope'];
                var myriad_host = address[legiond_scope] || '127.0.0.1';

                if(!workers[application_name]) {
                    var child = child_process.fork([__dirname,'health_checks'].join('/'), {
                        env : {
                            APPLICATION_NAME : application_name,
                            MYRIAD_HOST : myriad_host,
                            MYRIAD_PORT : process.env.MYRIAD_PORT || 2666,
                            LEGIOND_SCOPE: legiond_scope
                        },
                        execArgv: []
                    });

                    workers[application_name] = child;

                    child.on('message', function(message) {
                        if(message.type === 'log') {
                            core.loggers["containership.scheduler"].log(message.log.level, message.log.message);
                        } else if(message.type === 'health_check' && message.status === 'failed') {
                            return core.applications.redeploy_container(application_name, message.container, function(err, container) {
                                if(err) {
                                    return core.loggers["containership.scheduler"].log("error", err);
                                }
                            });
                        }
                    });
                }

                return fn && fn();
            }
        }
    }

}
