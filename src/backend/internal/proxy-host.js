'use strict';

const _                = require('lodash');
const error            = require('../lib/error');
const proxyHostModel   = require('../models/proxy_host');
const internalHost     = require('./host');
const internalNginx    = require('./nginx');
const internalAuditLog = require('./audit-log');

function omissions () {
    return ['is_deleted'];
}

const internalProxyHost = {

    /**
     * @param   {Access}  access
     * @param   {Object}  data
     * @returns {Promise}
     */
    create: (access, data) => {
        return access.can('proxy_hosts:create', data)
            .then(access_data => {
                // Get a list of the domain names and check each of them against existing records
                let domain_name_check_promises = [];

                data.domain_names.map(function (domain_name) {
                    domain_name_check_promises.push(internalHost.isHostnameTaken(domain_name));
                });

                return Promise.all(domain_name_check_promises)
                    .then(check_results => {
                        check_results.map(function (result) {
                            if (result.is_taken) {
                                throw new error.ValidationError(result.hostname + ' is already in use');
                            }
                        });
                    });
            })
            .then(() => {
                // At this point the domains should have been checked
                data.owner_user_id = access.token.get('attrs').id;

                return proxyHostModel
                    .query()
                    .omit(omissions())
                    .insertAndFetch(data);
            })
            .then(row => {
                // Configure nginx
                return internalNginx.configure(proxyHostModel, 'proxy_host', row)
                    .then(() => {
                        return internalProxyHost.get(access, {id: row.id, expand: ['owner']});
                    });
            })
            .then(row => {
                data.meta = _.assign({}, data.meta || {}, row.meta);

                // Add to audit log
                return internalAuditLog.add(access, {
                    action:      'created',
                    object_type: 'proxy-host',
                    object_id:   row.id,
                    meta:        data
                })
                    .then(() => {
                        return row;
                    });
            });
    },

    /**
     * @param  {Access}  access
     * @param  {Object}  data
     * @param  {Integer} data.id
     * @param  {String}  [data.email]
     * @param  {String}  [data.name]
     * @return {Promise}
     */
    update: (access, data) => {
        return access.can('proxy_hosts:update', data.id)
            .then(access_data => {
                // Get a list of the domain names and check each of them against existing records
                let domain_name_check_promises = [];

                if (typeof data.domain_names !== 'undefined') {
                    data.domain_names.map(function (domain_name) {
                        domain_name_check_promises.push(internalHost.isHostnameTaken(domain_name, 'proxy', data.id));
                    });

                    return Promise.all(domain_name_check_promises)
                        .then(check_results => {
                            check_results.map(function (result) {
                                if (result.is_taken) {
                                    throw new error.ValidationError(result.hostname + ' is already in use');
                                }
                            });
                        });
                }
            })
            .then(() => {
                return internalProxyHost.get(access, {id: data.id});
            })
            .then(row => {
                if (row.id !== data.id) {
                    // Sanity check that something crazy hasn't happened
                    throw new error.InternalValidationError('Proxy Host could not be updated, IDs do not match: ' + row.id + ' !== ' + data.id);
                }

                return proxyHostModel
                    .query()
                    .omit(omissions())
                    .patchAndFetchById(row.id, data)
                    .then(saved_row => {
                        saved_row.meta = internalHost.cleanMeta(saved_row.meta);

                        // Add to audit log
                        return internalAuditLog.add(access, {
                            action:      'updated',
                            object_type: 'proxy-host',
                            object_id:   row.id,
                            meta:        data
                        })
                            .then(() => {
                                return _.omit(saved_row, omissions());
                            });
                    });
            });
    },

    /**
     * @param  {Access}   access
     * @param  {Object}   data
     * @param  {Integer}  data.id
     * @param  {Array}    [data.expand]
     * @param  {Array}    [data.omit]
     * @return {Promise}
     */
    get: (access, data) => {
        if (typeof data === 'undefined') {
            data = {};
        }

        return access.can('proxy_hosts:get', data.id)
            .then(access_data => {
                let query = proxyHostModel
                    .query()
                    .where('is_deleted', 0)
                    .andWhere('id', data.id)
                    .allowEager('[owner,access_list,certificate]')
                    .first();

                if (access_data.permission_visibility !== 'all') {
                    query.andWhere('owner_user_id', access.token.get('attrs').id);
                }

                // Custom omissions
                if (typeof data.omit !== 'undefined' && data.omit !== null) {
                    query.omit(data.omit);
                }

                if (typeof data.expand !== 'undefined' && data.expand !== null) {
                    query.eager('[' + data.expand.join(', ') + ']');
                }

                return query;
            })
            .then(row => {
                if (row) {
                    row.meta = internalHost.cleanMeta(row.meta);
                    return _.omit(row, omissions());
                } else {
                    throw new error.ItemNotFoundError(data.id);
                }
            });
    },

    /**
     * @param {Access}  access
     * @param {Object}  data
     * @param {Integer} data.id
     * @param {String}  [data.reason]
     * @returns {Promise}
     */
    delete: (access, data) => {
        return access.can('proxy_hosts:delete', data.id)
            .then(() => {
                return internalProxyHost.get(access, {id: data.id});
            })
            .then(row => {
                if (!row) {
                    throw new error.ItemNotFoundError(data.id);
                }

                return proxyHostModel
                    .query()
                    .where('id', row.id)
                    .patch({
                        is_deleted: 1
                    })
                    .then(() => {
                        // Delete Nginx Config
                        return internalNginx.deleteConfig('proxy_host', row)
                            .then(() => {
                                return internalNginx.reload();
                            });
                    })
                    .then(() => {
                        // Add to audit log
                        row.meta = internalHost.cleanMeta(row.meta);

                        return internalAuditLog.add(access, {
                            action:      'deleted',
                            object_type: 'proxy-host',
                            object_id:   row.id,
                            meta:        _.omit(row, omissions())
                        });
                    });
            })
            .then(() => {
                return true;
            });
    },

    /**
     * All Hosts
     *
     * @param   {Access}  access
     * @param   {Array}   [expand]
     * @param   {String}  [search_query]
     * @returns {Promise}
     */
    getAll: (access, expand, search_query) => {
        return access.can('proxy_hosts:list')
            .then(access_data => {
                let query = proxyHostModel
                    .query()
                    .where('is_deleted', 0)
                    .groupBy('id')
                    .omit(['is_deleted'])
                    .allowEager('[owner,access_list,certificate]')
                    .orderBy('domain_names', 'ASC');

                if (access_data.permission_visibility !== 'all') {
                    query.andWhere('owner_user_id', access.token.get('attrs').id);
                }

                // Query is used for searching
                if (typeof search_query === 'string') {
                    query.where(function () {
                        this.where('domain_names', 'like', '%' + search_query + '%');
                    });
                }

                if (typeof expand !== 'undefined' && expand !== null) {
                    query.eager('[' + expand.join(', ') + ']');
                }

                return query;
            })
            .then(rows => {
                rows.map(row => {
                    row.meta = internalHost.cleanMeta(row.meta);
                });

                return rows;
            });
    },

    /**
     * Report use
     *
     * @param   {Integer} user_id
     * @param   {String}  visibility
     * @returns {Promise}
     */
    getCount: (user_id, visibility) => {
        let query = proxyHostModel
            .query()
            .count('id as count')
            .where('is_deleted', 0);

        if (visibility !== 'all') {
            query.andWhere('owner_user_id', user_id);
        }

        return query.first()
            .then(row => {
                return parseInt(row.count, 10);
            });
    }
};

module.exports = internalProxyHost;