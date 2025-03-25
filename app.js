const { CloudAdapter, ConfigurationBotFrameworkAuthentication, ActivityHandler, TurnContext, ActivityTypes, CardFactory } = require('botbuilder');
const { CosmosClient } = require("@azure/cosmos");
const restify = require('restify');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const axios = require('axios');

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
if (ENVIRONMENT === 'production') {
    MicrosoftAppId = process.env.MicrosoftAppId;
    MicrosoftAppPassword = process.env.MicrosoftAppPassword;
    MicrosoftTenantId = process.env.MicrosoftTenantId;
    botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: MicrosoftAppId,
        MicrosoftAppPassword: MicrosoftAppPassword,
        MicrosoftAppTenantId: MicrosoftTenantId,
        MicrosoftAppType: 'SingleTenant',
    });
} else if (ENVIRONMENT === 'staging') {
    MicrosoftAppId = process.env.MicrosoftAppId;
    MicrosoftAppPassword = process.env.MicrosoftAppPassword;
    botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: MicrosoftAppId,
        MicrosoftAppPassword: MicrosoftAppPassword,
        MicrosoftAppType: 'MultiTenant',
    });
} else if (ENVIRONMENT === 'local') {
    MicrosoftAppId = process.env.TestMicrosoftAppId;
    MicrosoftAppPassword = process.env.TestMicrosoftAppPassword;
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
            if (text === 'subscribe') {
                const card = {
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: "TextBlock",
                            text: "SCM Agent provide following functions:",
                            size: "Large",
                            weight: "Bolder"
                        },
                        {
                            type: "TextBlock",
                            text: "Please select one option.",
                            wrap: true
                        }
                    ],
                    actions: [
                        {
                            type: "Action.Submit",
                            title: "basic SCM look up",
                            data: {
                                action: "basic"
                            }
                        },
                        {
                            type: "Action.Submit",
                            title: "notify",
                            data: {
                                action: "notify"
                            }
                        }
                    ]
                };
                await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
            } else if (context.activity.value && context.activity.value.action === 'notify') {
                const userName = context.activity.from.name;
                const userId = context.activity.from.id;
                const conversationReference = TurnContext.getConversationReference(context.activity);
                await saveUserToDB(userName, userId, conversationReference, 'notify');
                await context.sendActivity(`HI, ${userName}, subscribe notify successfully!`);
            } else if (context.activity.value && context.activity.value.action === 'basic') {
                await context.sendActivity(`HI, ${userName}, subscribe basic successfully!`);
            } else if (text === 'card') {
                await context.sendActivity({
                    text: "請選擇一個選項",
                    type: "message",
                    attachments: [{
                        contentType: "application/vnd.microsoft.card.hero",
                        content: {
                            title: "選項卡",
                            buttons: [{ type: "imBack", title: "查詢料號窗口", value: "AIMB-505G2-00A1E的SCM窗口是誰" }]
                        }
                    }]
                });
            } else {
                let typingInterval;
                try {
                    // Send typing animation immediately
                    await context.sendActivity({type: ActivityTypes.Typing});

                    // Save conversation reference
                    const conversationReference = TurnContext.getConversationReference(context.activity);
                    this.conversationReferences[context.activity.from.id] = conversationReference;

                    // Send typing animation
                    typingInterval = setInterval(async () => {
                        await this.adapter.continueConversationAsync(MicrosoftAppId, conversationReference, async (turnContext) => {
                            await turnContext.sendActivity({ type: ActivityTypes.Typing });
                        });
                    }, 3000);

                    // 1. Create or get thread
                    const threadResponse = await axios({
                        method: 'POST',
                        url: `${SCM_API_BASE_ENDPOINT}/v2/threads`,
                        headers: {
                            'SCM_API_KEY': SCM_API_KEY,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            "thread_id": "thread_123",
                            "messages": []
                        }
                    });
                    
                    if (threadResponse.status !== 200) {
                        throw new Error(`創建 thread 失敗: ${threadResponse.statusText}`);
                    }
                    const threadData = threadResponse.data;
                    const threadId = threadData.id;
                    // const threadId = TEST_THREAD_ID;

                    // 2. Send user message in thread
                    const userMessage = context.activity.text;
                    const authRole = 'Default'; // TODO: process auth_role
                    const messageResponse = await axios({
                        method: 'POST',
                        url: `${SCM_API_BASE_ENDPOINT}/v2/threads/${threadId}/messages`,
                        headers: {
                            'SCM_API_KEY': SCM_API_KEY,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            content: userMessage,
                            message_role: 'user',
                            auth_role: authRole
                        }
                    });
                    
                    if (messageResponse.status !== 200) {
                        throw new Error(`發送消息失敗: ${messageResponse.statusText}`);
                    }
                    // 3. Create run
                    const runResponse = await axios({
                        method: 'post',
                        url: `${SCM_API_BASE_ENDPOINT}/v2/threads/${threadId}/runs`,
                        headers: {
                            'SCM_API_KEY': `${SCM_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        data: {
                            assistant_id: SCM_ASSISTANT_ID,
                            stream: true
                        },
                        responseType: 'stream'
                    });
                    
                    if (runResponse.status !== 200) {
                        throw new Error(`創建 run 失敗: ${runResponse.statusText}`);
                    }

                    // Process stream response
                    // TODO: don't use stream response, use async await to get final message
                    let currentEvent = null;
                    runResponse.data.on('data', async (chunk) => {
                        const lines = chunk.toString().split('\n');
                        for (const line of lines) {
                            if (line.startsWith('event: ')) {
                                currentEvent = line.replace('event: ', '').trim();
                            } else if (line.startsWith('data: ')) {
                                const dataStr = line.replace('data: ', '').trim();
                                try {
                                    // Process thread.message.completed event to get final message
                                    if (currentEvent === 'thread.message.completed') {
                                        const data = JSON.parse(dataStr);
                                        const finalContent = data.content[0].text.value;
                                        console.log("finalContent", finalContent);
                                        // clear typing animation & send final message
                                        clearInterval(typingInterval);
                                        typingInterval = null;
                                        await this.adapter.continueConversationAsync(MicrosoftAppId, conversationReference, async (turnContext) => {
                                            await turnContext.sendActivity(`${finalContent}`);
                                        });
                                    }

                                    // Process error event during stream process
                                    if (currentEvent === 'error') {
                                        console.error('Stream error from server:', dataStr);
                                    }
                                } catch (error) {
                                    clearInterval(typingInterval);
                                    typingInterval = null;
                                    console.error(`Error parsing ${currentEvent} data:`, error);
                                }
                            }
                        }
                    });

                    runResponse.data.on('end', async () => {
                        console.log('Stream connection closed');
                    });

                } catch (error) {
                    console.error('API 調用錯誤:', error);
                    if (typingInterval) {
                        clearInterval(typingInterval);
                        typingInterval = null;
                    }
                    await context.sendActivity('處理您的請求時發生錯誤。');
                } finally {
                    if (typingInterval) {
                        clearInterval(typingInterval);
                        typingInterval = null;
                    }
                }
            }
            await next();
        });

        // Process member added event
        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded;
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

// Save user to DB
async function saveUserToDB(userName, userId, conversationReference, subscription) {
    try {
        const database = DBClient.database(cosmosDBDatabaseId);
        const container = database.container(cosmosDBContainerId);

        const user = {
            id: userId,
            name: userName,
            subscription: subscription,
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

// API Key validation middleware
function validateApiKey(req, res, next) {
    const apiKey = req.headers['scm_api_key'];
    const expectedApiKey = process.env.SCM_API_KEY;

    if (!apiKey || apiKey !== expectedApiKey) {
        res.send(401, { error: 'Unauthorized - Invalid API Key' });
        return;
    }
    return next();
}

// CORS middleware
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

// Add proactive pullin notification endpoint
server.post('/api/notifications/pullin', validateApiKey, async (req, res) => {
    const jobId = req.body['job_id'];
    const config = { jobName: 'pullin', jobId: jobId };
    const NOTIFICATION_ENDPOINT = process.env.NOTIFICATION_ENDPOINT;
    await axios.post(NOTIFICATION_ENDPOINT, config);
    res.send(200, '通知已發送');
});

// Add proactive customer notification endpoint
server.post('/api/notifications/customer', validateApiKey, async (req, res) => {
    const config = { jobName: 'customer' };
    const NOTIFICATION_ENDPOINT = process.env.NOTIFICATION_ENDPOINT;
    await axios.post(NOTIFICATION_ENDPOINT, config);
    res.send(200, '通知已發送');
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
