const _ = require('lodash');

function updateContainerMyriadState(core, options, cb) {
    if(_.has(options, 'respawn') && !options.respawn) {
        deleteContainer(core, options, cb);
    } else {
        //Get the container -
        core.cluster.myriad.persistence.get(_.join([core.constants.myriad.CONTAINERS_PREFIX, options.application_name, options.container_id], core.constants.myriad.DELIMITER), {local: false}, (err, container) => {
            if(err) {
                return cb(err);
            } else {
                try {
                    container = JSON.parse(container);

                    //Update fields
                    container = _.merge(container,
                        _.pick(options, ['host', 'start_time', 'tags', 'engine', 'host_port', 'container_port', 'status']),
                        {host_port: options.status === 'unloaded' && container.random_host_port ? null : container.host_port});

                    //And persist.
                    core.cluster.myriad.persistence.set(_.join([core.constants.myriad.CONTAINERS_PREFIX, options.application_name, options.container_id], core.constants.myriad.DELIMITER), JSON.stringify(container), cb);

                } catch(err) {
                    return cb(err);
                }
            }
        });
    }
}

function deleteContainerMyriadState(core, options, cb) {
    core.cluster.myriad.persistence.delete(_.join([core.constants.myriad.CONTAINERS_PREFIX, options.application_name, options.container_id], core.constants.myriad.DELIMITER), cb);
}

function setContainerMyriadStateUnloaded(core, options, shouldRespawn) {
    updateContainerMyriadState(core, _.merge({
        application_name: options.application_name,
        container_id: options.container_id,
        status: 'unloaded',
        host: null,
        start_time: null
    }, shouldRespawn != undefined ? {respawn: should_respawn} : {}), (err) => {
        if(err) {
            core.loggers['containership.scheduler'].log('warn', `Failed to unload ${options.application_name} container: ${options.container_id}`);
            core.loggers['containership.scheduler'].log('error', err.message);
        }
    });
}

function safeJsonParse(value) {
    if (typeof value !== 'string') {
        return value;
    }

    try {
        value = JSON.parse(value);
    } catch(e) { /* ignore */ }

    return value;
}

module.exports = {deleteContainerMyriadState, safeJsonParse, setContainerMyriadStateUnloaded, updateContainerMyriadState};
