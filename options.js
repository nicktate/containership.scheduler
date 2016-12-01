module.exports = {

    "harmonization-interval": {
        help: "Interval on which container harmonization occurs",
        metavar: "INTERVAL",
        default: 15000
    },

    "max-docker-container-age": {
        help: "Amount of time before a killed / stopped docker container is cleaned up on disk(hours)",
        metavar: "HOURS",
        default: 6
    },

    "max-docker-image-age": {
        help: "Amount of time before an unused docker image is cleaned up on disk(hours)",
        metavar: "HOURS",
        default: 6
    }

}
