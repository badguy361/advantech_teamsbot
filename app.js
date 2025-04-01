const { CloudAdapter, ConfigurationBotFrameworkAuthentication, ActivityHandler, TurnContext, ActivityTypes, CardFactory } = require('botbuilder');
const { CosmosClient } = require("@azure/cosmos");
const restify = require('restify');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cards = require('./cards');
const { SCMChatService } = require('./services/index');

dotenv.config();
const PORT = process.env.PORT || 3978;
const ENVIRONMENT = process.env.ENVIRONMENT;
const SCM_API_KEY = process.env.SCM_API_KEY;
const SCM_API_BASE_ENDPOINT = process.env.SCM_API_BASE_ENDPOINT;
const TEST_API_BASE_ENDPOINT = process.env.TEST_API_BASE_ENDPOINT;
const SCM_ASSISTANT_ID = process.env.AZURE_ASSISTANT_THREAD_ID;
const TEST_THREAD_ID = process.env.TEST_THREAD_ID;

// setup bot framework authentication
let botFrameworkAuthentication;
let MicrosoftAppId;
let MicrosoftAppPassword;
let MicrosoftTenantId;
let NOTIFICATION_ENDPOINT;
if (ENVIRONMENT === 'production') {
    MicrosoftAppId = process.env.MicrosoftAppId;
    MicrosoftAppPassword = process.env.MicrosoftAppPassword;
    MicrosoftTenantId = process.env.MicrosoftTenantId;
    NOTIFICATION_ENDPOINT = process.env.NOTIFICATION_ENDPOINT;
    botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: MicrosoftAppId,
        MicrosoftAppPassword: MicrosoftAppPassword,
        MicrosoftAppTenantId: MicrosoftTenantId,
        MicrosoftAppType: 'SingleTenant',
    });
} else if (ENVIRONMENT === 'staging') {
    MicrosoftAppId = process.env.TestMicrosoftAppId;
    MicrosoftAppPassword = process.env.TestMicrosoftAppPassword;
    NOTIFICATION_ENDPOINT = process.env.NOTIFICATION_ENDPOINT;
    botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: MicrosoftAppId,
        MicrosoftAppPassword: MicrosoftAppPassword,
        MicrosoftAppType: 'MultiTenant',
    });
} else if (ENVIRONMENT === 'local') {
    MicrosoftAppId = process.env.TestMicrosoftAppId;
    MicrosoftAppPassword = process.env.TestMicrosoftAppPassword;
    NOTIFICATION_ENDPOINT = process.env.TEST_NOTIFICATION_ENDPOINT;
    botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: MicrosoftAppId,
        MicrosoftAppPassword: MicrosoftAppPassword,
        MicrosoftAppType: 'MultiTenant',
    });
}
const adapter = new CloudAdapter(botFrameworkAuthentication);

// setup Cosmos DB connection
const cosmosDBEndpoint = process.env.DB_ENDPOINT;
const cosmosDBKey = process.env.DB_KEY;
const cosmosDBDatabaseId = process.env.DB_DATABASE;
const cosmosDBContainerId = process.env.DB_CONTAINER;
const DBClient = new CosmosClient({ endpoint: cosmosDBEndpoint, key: cosmosDBKey });

const config = {
    scm: {
        SCM_API_KEY,
        SCM_API_BASE_ENDPOINT,
        TEST_API_BASE_ENDPOINT,
        SCM_ASSISTANT_ID,
        TEST_THREAD_ID,
    },
    microsoft: {
        MicrosoftAppId,
        MicrosoftAppPassword,
        MicrosoftTenantId,
        NOTIFICATION_ENDPOINT,
    },
    cosmosDB: {
        cosmosDBEndpoint,
        cosmosDBKey,
        cosmosDBDatabaseId,
        cosmosDBContainerId,
    },
    environment: {
        ENVIRONMENT,
        PORT,
    }
}   
// Error handling
adapter.onTurnError = async (context, error) => {
    console.error(`\n [onTurnError] Unhandled error: ${error.message}\n${error.stack}`);
    try {
        await context.sendActivity(`Error: ${error.message}`);
    } catch (err) {
        console.error("Error when sending response:", err);
    }
};

// Save conversation references
const conversationReferences = {};

// Custom Teams Bot
class TeamsBot extends ActivityHandler {
    constructor(adapter) {
        super();
        this.conversationReferences = conversationReferences;
        this.adapter = adapter;

        // Process message events
        this.onMessage(async (context, next) => {
            const text = context.activity.text;
            const userName = context.activity.from.name;
            const userId = context.activity.from.id;
            const database = DBClient.database(cosmosDBDatabaseId);
            const container = database.container(cosmosDBContainerId);
            const { resource: user } = await container.item(userId).read();
            if (text === 'subscribe' || text === 'sub') {
                try {
                    // Clone subscription card
                    const customSubscriptionCard = JSON.parse(JSON.stringify(cards.subscription));

                    // If user exists and has subscription info, update the default value of each Toggle
                    if (user && user.subscriptions) {
                        customSubscriptionCard.body = customSubscriptionCard.body.map(item => {
                            if (item.type === 'Input.Toggle') {
                                return {
                                    ...item,
                                    value: user.subscriptions.includes(item.id).toString() // convert to string 'true' or 'false'
                                };
                            }
                            return item;
                        });
                    }

                    await context.sendActivity({ 
                        attachments: [CardFactory.adaptiveCard(customSubscriptionCard)] 
                    });
                } catch (error) {
                    console.error("獲取用戶訂閱資訊時發生錯誤:", error);
                    await context.sendActivity({ 
                        attachments: [CardFactory.adaptiveCard(cards.subscription)] 
                    });
                }
            } else if (context.activity.value && context.activity.value.action === 'confirmSubscription') {
                const conversationReference = TurnContext.getConversationReference(context.activity);
                const selectedServices = [];

                // Collect all selected services
                if (context.activity.value.SCM_bot === 'true') {
                    selectedServices.push('SCM bot');
                }
                if (context.activity.value.pull_in === 'true') {
                    selectedServices.push('Pull-in Agent');
                }
                if (context.activity.value.LTB_customer === 'true') {
                    selectedServices.push('LTB customer Agent');
                }

                // Save all subscriptions
                try {
                    if (selectedServices.length > 0) {
                        await saveUserSubscriptionsToDB(userName, userId, conversationReference, selectedServices);
                        await context.sendActivity({
                            text: `HI, ${userName}, successfully subscribed to: ${selectedServices.join(', ')}!`,
                            importance: 'high'
                        });
                    } else {
                        await context.sendActivity(`Please select at least one service.`);
                    }
                } catch (error) {
                    console.error("儲存用戶資料時發生錯誤:", error);
                    await context.sendActivity(`儲存用戶資料時發生錯誤。`);
                    throw error;
                }
            } else if (text === 'menu') {
                await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.menu.default)] });
            } else if (context.activity.value && context.activity.value.action != 'confirmSubscription') {
                const action = context.activity.value.action;

                switch (action) {
                    case "basic_data":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.items.basicData)] });
                        break;
                    case "atp_info":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.items.atpInfo)] });
                        break;
                    case "so_gating_item":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.soGatingItems)] });
                        break;
                    case "shipment_rate":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.items.shipmentRate)] });
                        break;

                    case "master_data_form":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.masterData)] });
                        break;
                    case "pm_scm_planner_form":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.pmScmPlanner)] });
                        break;
                    case "hts_coo_eccn_form":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.htsCooEccn)] });
                        break;
                    case "lt_atp_form":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.ltAtp)] });
                        break;
                    case "single_item_form":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.singleItem)] });
                        break;
                    case "btos_form":
                        await context.sendActivity({ attachments: [CardFactory.adaptiveCard(cards.forms.btos)] });
                        break;

                    case "submit_query":
                        const source = context.activity.value.source;
                        let query;
                        let material;
                        let plant;
                        let quantity;
                        let date;
                        let soNumber;
                        let shipmentType;
                        let supplier;
                        let materialQuantity;
                        let postalCode;
                        let city;
                        let country;

                        switch (source) {
                            case "master_data_form":
                                material = context.activity.value.material || "AIMB-505G2-00A1E";
                                plant = context.activity.value.plant || "TWH1";
                                query = `請幫我查詢${material}在${plant}的物料主檔資訊`;
                                break;
                            case "pm_scm_planner_form":
                                material = context.activity.value.material || "AIMB-505G2-00A1E";
                                query = `請幫我查詢${material}的PM、SCM、Planner`;
                                break;
                            case "hts_coo_eccn_form":
                                material = context.activity.value.material || "AIMB-505G2-00A1E";
                                query = `請幫我查詢${material}的HTS、COO、ECCN`;
                                break;
                            case "lt_atp_form":
                                material = context.activity.value.material || "AIMB-505G2-00A1E";
                                plant = context.activity.value.plant;
                                quantity = context.activity.value.quantity;
                                date = context.activity.value.date || new Date().toISOString().split('T')[0];
                                if (!quantity) {
                                    query = `請幫我查詢${material}在${plant}的L/T,ATP，日期${date}`;
                                } else {
                                    query = `顧客想在${date}訂購${material}，數量為${quantity}個,L/T和ATP的狀況如何?`;
                                }
                                break;
                            case "so_gating_item_form":
                                soNumber = context.activity.value.so_number || "未提供訊息";
                                query = `請幫我查詢SO:${soNumber}最晚交期是那個item?`;
                                break;
                            case "single_item_form":
                                shipmentType = context.activity.value.shipment_type;
                                supplier = context.activity.value.supplier;
                                materialQuantity = context.activity.value.material_quantity;
                                postalCode = context.activity.value.postal_code;
                                city = context.activity.value.city;
                                country = context.activity.value.country;
                                query = `請幫我計算運費: ${materialQuantity} 寄到郵遞區號為 ${postalCode} 的 ${city} ${country}，請問這樣 ${shipmentType} 的運費多少?`;
                                break;
                            case "btos_form":
                                shipmentType = context.activity.value.shipment_type;
                                supplier = context.activity.value.supplier;
                                materialQuantity = context.activity.value.material_quantity;
                                parentMaterial = context.activity.value.parent_material;
                                postalCode = context.activity.value.postal_code;
                                city = context.activity.value.city;
                                country = context.activity.value.country;
                                query = `計算運費: ${parentMaterial} 而以下的物料階為他的子階${materialQuantity} 寄到郵遞區號為 ${postalCode} 的 ${city} ${country}，請問這樣 ${shipmentType} 的運費多少?`;
                                break;
                        }
                        await context.sendActivity({text: query});
                        await handleChatMessageWithTyping(context, query, config, MicrosoftAppId, conversationReferences, adapter);
                        break;
                }
            } else {
                if (user && user.subscriptions && user.subscriptions.includes('SCM bot')) {
                    await handleChatMessageWithTyping(context, text, config, MicrosoftAppId, conversationReferences, adapter);
                } else {
                    await context.sendActivity('您尚未訂閱任何Bot服務，可透過關鍵字 subscribe 訂閱。/ \
                        You have not subscribed to any Bot services, you can subscribe through the keyword subscribe.');
                }
            }
            await next();
        });

        // Process member added event
        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded;
            const conversationReference = TurnContext.getConversationReference(context.activity);
            const userName = context.activity.from.name;
            const userId = context.activity.from.id;
            await saveUserSubscriptionsToDB(userName, userId, conversationReference, ['basic']);
            for (let member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(`Welcome to SCM Agent！`);
                    break;
                }
            }
            await next();
        });
    }
}

/**
 * Handles a chat message, including sending typing indicators and processing the message with the SCMChatService.
 *
 * @param {TurnContext} context The TurnContext for the current turn.
 * @param {string} text The text of the user's message.
 * @param {object} config The configuration object for the SCMChatService.
 * @param {string} MicrosoftAppId The Microsoft App ID.
 * @param {object} conversationReferences The object storing conversation references.
 * @param {object} adapter The bot adapter.
 * @returns {Promise<void>} A promise that resolves when the message has been handled.
 */
async function handleChatMessageWithTyping(context, text, config, MicrosoftAppId, conversationReferences, adapter) {
    let typingInterval;

    try {
        // Send typing animation immediately
        await context.sendActivity({ type: ActivityTypes.Typing });

        // Save conversation reference
        const conversationReference = TurnContext.getConversationReference(context.activity);
        conversationReferences[context.activity.from.id] = conversationReference;

        // Send typing animation at intervals
        typingInterval = setInterval(async () => {
            await adapter.continueConversationAsync(MicrosoftAppId, conversationReference, async (turnContext) => {
                await turnContext.sendActivity({ type: ActivityTypes.Typing });
            });
        }, 3000);

        // process chat flow
        console.log("question, ", text);
        const scmChatService = new SCMChatService(config);
        const response = await scmChatService.handleChatMessage(text);

        await adapter.continueConversationAsync(MicrosoftAppId, conversationReference, async (turnContext) => {
            await turnContext.sendActivity(`${response}`);
        });

    } catch (error) {
        console.error('API 調用錯誤:', error);
        await context.sendActivity('處理您的請求時發生錯誤。');

    } finally {
        if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
        }
    }
}

/**
 * save user subscriptions to DB
 * @param {string} user_name - user name
 * @param {string} user_id - user id
 * @param {object} conversation_reference - conversation reference
 * @param {array} subscriptions - subscriptions
 */
async function saveUserSubscriptionsToDB(userName, userId, conversationReference, subscriptions) {
    try {
        const database = DBClient.database(cosmosDBDatabaseId);
        const container = database.container(cosmosDBContainerId);

        const user = {
            id: userId,
            name: userName,
            subscriptions: subscriptions,
            conversationReference: conversationReference,
            registeredDate: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };

        const { resource: upsertedItem } = await container.items.upsert(user);
        console.log(`已儲存用戶資料: ${upsertedItem.id}`);
        return upsertedItem;


    } catch (error) {
        console.error("儲存用戶資料時發生錯誤:", error);
        throw error;
    }
}

/**
 * check user non existing in DB
 * @param {Array} userNames - user names
 * @returns {Promise<Array>}
 */
async function checkUserNonExisting(userNames) {
    try {
        const database = DBClient.database(cosmosDBDatabaseId);
        const container = database.container(cosmosDBContainerId);

        // look up user names in DB
        const querySpec = {
            query: `
                SELECT c.name 
                FROM c 
                WHERE ARRAY_CONTAINS(@userNames, c.name)
            `,
            parameters: [
                {
                    name: "@userNames",
                    value: userNames
                }
            ]
        };

        const { resources: existingUsers } = await container.items.query(querySpec).fetchAll();
        const existingUserNames = existingUsers.map(user => user.name);

        const nonExistingUsers = userNames.filter(name => !existingUserNames.includes(name));

        console.log("nonExistingUsers", nonExistingUsers);
        return nonExistingUsers;

    } catch (error) {
        console.error("檢查用戶是否存在時發生錯誤:", error);
        throw error;
    }
}

/**
 * check user subscription
 * @param {Array} userNames - user names
 * @param {string} jobName - job name
 * @returns {Promise<Array>}
 */
async function checkUserSubscription(userNames, jobName) {
    try {
        const database = DBClient.database(cosmosDBDatabaseId);
        const container = database.container(cosmosDBContainerId);

        // look up user names in DB
        const querySpec = {
            query: `
                SELECT c.name, c.subscriptions
                FROM c
                WHERE ARRAY_CONTAINS(@userNames, c.name)
            `,
            parameters: [
                {
                    name: "@userNames",
                    value: userNames
                }
            ]
        };

        const { resources: users } = await container.items.query(querySpec).fetchAll();

        // filter out users who do not have `jobName` in their subscriptions
        const isNotSubscribedUsers = users
            .filter(user => !user.subscriptions || !user.subscriptions.includes(jobName))
            .map(user => user.name);

        console.log("isNotSubscribedUsers", isNotSubscribedUsers);
        return isNotSubscribedUsers;

    } catch (error) {
        console.error(`檢查用戶訂閱狀態時發生錯誤: ${error.message}`);
        throw error;
    }
}

/**
 * API Key validation middleware
 * @param {object} req - request object
 * @param {object} res - response object
 * @param {function} next - next middleware function
 */
function validateApiKey(req, res, next) {
    const apiKey = req.headers['scm_api_key'];
    const expectedApiKey = process.env.SCM_API_KEY;

    if (!apiKey || apiKey !== expectedApiKey) {
        res.send(401, { error: 'Unauthorized - Invalid API Key' });
        return;
    }
    return next();
}

/**
 * CORS middleware
 * @param {object} req - request object
 * @param {object} res - response object
 * @param {function} next - next middleware function
 */
function corsMiddleware(req, res, next) {
    res.header('Access-Control-Allow-Origin', 'xxx');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, SCM_API_KEY');
    if (req.method === 'OPTIONS') {
        res.send(200);
        return;
    }
    next();
}

// Create bot instance
const bot = new TeamsBot(adapter);

// Create server
const server = restify.createServer();
server.use(restify.plugins.bodyParser());
server.use(corsMiddleware);

// Add proactive notification endpoint
server.post('/api/notifications', validateApiKey, async (req, res) => {
    const jobName = req.body['job_name'];
    let userNames;
    let message;
    if (jobName === 'Pull-in Agent') {
        const jobId = req.body['job_id'];
        if (!jobId) {
            res.send(400, 'job_id is required');
            return;
        }
        userNames = ['Joey.Chang', 'Tina.Chen']; // TODO: use jobid to get userName from HANA
        message = 'Pull-in Agent'; // TODO: usee jobid get message from HANA
    } else if (jobName === 'LTB customer Agent') {
        userNames = ['Joey.Chang', 'Tina.Chen']; // TODO: get userName(person in charge) from cosmos DB
        message = 'LTB customer Agent'; // TODO: get message through SIS from SQL server
    }

    if (!userNames || !message) {
        res.send(400, 'job_name is not found');
        return;
    }

    // check user is existing in DB and subscribed to the job
    const isNotExistingUsers = await checkUserNonExisting(userNames);
    const isNotSubscribedUsers = await checkUserSubscription(userNames, jobName);
    const validUserNames = userNames.filter(userName => 
        !isNotExistingUsers.includes(userName) && 
        !isNotSubscribedUsers.includes(userName)
    );

    if (validUserNames.length > 0) {
        await axios.post(NOTIFICATION_ENDPOINT, { userNames: validUserNames, message });
    }

    if (isNotExistingUsers.length > 0 || isNotSubscribedUsers.length > 0) {
        const messageLines = ['通知已發送。'];
        if (isNotExistingUsers.length > 0) {
            messageLines.push(`以下用戶未安裝 SCM Agent: ${isNotExistingUsers.join(', ')}。`);
        }
        if (isNotSubscribedUsers.length > 0) {
            messageLines.push(`以下用戶未訂閱 ${jobName} 服務: ${isNotSubscribedUsers.join(', ')}。`);
        }

        const message = messageLines.join(' ');
        res.send(200, message);
    } else {
        res.send(200, '通知已發送');
    }
});

// Configure server message endpoint
server.post('/api/messages', async (req, res) => {
    // verify token
    // const authHeader = req.headers['authorization'] || '';
    // if (authHeader) {
    //     const token = authHeader.replace('Bearer ', '');
    //     try {
    //         const decodedToken = jwt.decode(token, { complete: true });
    //     } catch (err) {
    //         console.error("Error decoding token:", err);
    //     }
    // } else {
    //     console.warn("Authorization header not found!");
    // }

    await adapter.process(req, res, async (context) => {
        // const tenantId = context.activity.channelData?.tenant?.id;
        // console.log("Get Tenant ID：", tenantId);
        await bot.run(context);
    });
});

server.listen(PORT, () => {
    const baseUrl = process.env.WEBSITE_HOSTNAME
        ? `https://${process.env.WEBSITE_HOSTNAME}`
        : `http://localhost:${PORT}`;
    console.log(`Server is starting, URL: ${baseUrl}`);
});
