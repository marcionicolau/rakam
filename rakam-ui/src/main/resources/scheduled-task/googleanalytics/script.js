//@ sourceURL=rakam-ui/src/main/resources/scheduled-task/googleanalytics/script.js

var oauth_url = "https://d2p3wisckg.execute-api.us-east-2.amazonaws.com/prod/google";
var report_url = "https://analyticsreporting.googleapis.com/v4/reports:batchGet";

var fetch = function (parameters, startDate, endDate, nextToken) {
    logger.debug("Fetching between " + startDate + " and " + (endDate || 'now') + (nextToken ? (' with token ' + nextToken) : ''));
    if(nextToken == null) {
        var token = config.get('cursor');
        if (token != null) {
            var parsed = token.split(' ');
            endDate = parsed[0];
            nextToken = parsed[1];
        }
    }

    if (endDate == null) {
        endDate = new Date();
        endDate.setDate(endDate.getDate() - 1);
        endDate = endDate.toJSON().slice(0, 10);
    }

    startDate = startDate || config.get('start_date');

    if (startDate == null) {
        startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 2);
        startDate = startDate.toJSON().slice(0, 10);
    }

    if (startDate === endDate) {
        logger.info("No data to process");
        return;
    }

    var response = http.get(oauth_url)
        .query('refresh_token', parameters.refresh_token)
        .send();

    if (response.getStatusCode() == 0) {
        throw new Error(response.getResponseBody());
    }

    if (response.getStatusCode() != 200) {
        throw new Error(response.getResponseBody());
    }

    var token = response.getResponseBody();
    var metrics = parameters.metrics.split(',');
    var dimensions = parameters.dimensions.split(',');
    response = http.post(report_url)
        .header('Authorization', token)
        .data(JSON.stringify({
            reportRequests: [
                {
                    viewId: parameters.profile_id,
                    pageToken: nextToken,
                    pageSize: 10000,
                    dateRanges: [{"startDate": startDate, "endDate": endDate}],
                    metrics: metrics.map(function (metric) { return {"expression": metric} }),
                    dimensions: dimensions.map(function (dim) { return {"name": dim} }),
                    segments: parameters.segment ? [{"segmentId": parameters.segment_id}] : undefined,
                    dimensionFilterClauses: parameters.dimension_filter ? [
                        {
                            filters: [
                                {
                                    dimensionName: parameters.dimension_filter.split(' ', 3)[0],
                                    operator: parameters.dimension_filter.split(' ', 3)[1],
                                    expressions: JSON.parse(parameters.dimension_filter.split(' ', 3)[2])
                                }
                            ]
                        }
                    ] : undefined
                }
            ]
        }))
        .send();

    if (response.getStatusCode() != 200) {
        throw new Error(response.getResponseBody());
    }

    var data = JSON.parse(response.getResponseBody());

    var metricMappers = data.reports[0].columnHeader
        .metricHeader.metricHeaderEntries.map(function (item) {
            if (item.type == 'INTEGER') {
                return parseInt;
            }
            else if (item.type == 'CURRENCY') {
                return parseFloat;
            }
            else {
                return function (a) { return a };
            }
        });

    var events = [];
    var report = data.reports[0];
    (report.data.rows || []).forEach(function (row) {
        row.metrics.forEach(function (metricValues) {
            var properties = {};
            dimensions.forEach(function (dimension, idx) {
                var value = row.dimensions[idx];

                if (dimension == 'ga:dateHour') {
                    dimension = '_time';
                    value = value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8) + "T" + value.substring(8, 10) + ":00:00";
                }
                if (value !== '(not set)') {
                    properties[dimension] = value;
                }
            });

            metrics.forEach(function (metric, idx) {
                properties[metric] = metricMappers[idx](metricValues.values[idx]);
            });

            events.push({collection: parameters.collection, properties: properties});
        });
    });

    if (report.nextPageToken && report.nextPageToken) {
        eventStore.store(events);
        config.set('cursor', endDate + " " + report.nextPageToken);
        return fetch(parameters, startDate, endDate, report.nextPageToken);
    }

    eventStore.store(events);
    config.set('cursor', null);
    config.set('start_date', endDate);
}

var main = function (parameters) {
    return fetch(parameters)
}