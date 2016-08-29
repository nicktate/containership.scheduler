'use strict';

const ContainershipScheduler = require('./containership-scheduler');
const pkg = require('./package.json');
const options = require('./options');

// instantiate new Containership Scheduler
module.exports = function() {
    let scheduler = new ContainershipScheduler();
    scheduler.version = pkg.version;
    scheduler.options = options;
    return scheduler;
};
