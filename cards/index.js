module.exports = {
    subscription: require('./subscription.json'),
    menu: {
        default: require('./default-menu.json'),
    },
    forms: {
        masterData: require('./form-Master_data.json'),
        pmScmPlanner: require('./form-PM_SCM_Planner.json'),
        htsCooEccn: require('./form-HTS_COO_ECCN.json'),
        ltAtp: require('./form-LT_ATP.json'),
        soGatingItems: require('./form-SO_gating_items.json'),
        singleItem: require('./form-Single_item.json'),
        btos: require('./form-Btos.json')
    },
    items: {
        atpInfo: require('./item-ATP_info.json'),
        basicData: require('./item-Basic_data.json'),
        shipmentRate: require('./item-Shipment_rate.json')
    }
};