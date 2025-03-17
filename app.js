const { CloudAdapter, ConfigurationBotFrameworkAuthentication, ActivityHandler, TurnContext, ActivityTypes, CardFactory } = require('botbuilder');
const restify = require('restify');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const https = require('https');
const fs = require('fs');

dotenv.config();
const PORT = process.env.PORT || 3978;
const ENVIRONMENT = process.env.ENVIRONMENT;
const SCM_API_KEY = process.env.SCM_API_KEY;
const SCM_API_BASE_ENDPOINT = process.env.SCM_API_BASE_ENDPOINT;
const TEST_API_BASE_ENDPOINT = process.env.TEST_API_BASE_ENDPOINT;
const SCM_ASSISTANT_ID = process.env.AZURE_ASSISTANT_THREAD_ID;
const TEST_THREAD_ID = process.env.TEST_THREAD_ID;

// const agent = new https.Agent({
//     rejectUnauthorized: false
// });

// 1. 讀取 CA 憑證檔案
const caCertPath = 'pem/scm_cert.pem'; // 將這裡替換為你的 CA 憑證檔案路徑
const gdig2Path = 'pem/gdig2.crt.pem'; // 將這裡替換為你的 CA 憑證檔案路徑
let caCert = null;
let gdig2 = null;

try {
    caCert = fs.readFileSync(caCertPath);
    gdig2 = fs.readFileSync(gdig2Path);
} catch (error) {
    console.error(`無法讀取 CA 憑證檔案: ${caCertPath}`, error);
    // 處理無法讀取憑證的情況，例如拋出錯誤或使用其他預設行為
    throw error; // 拋出錯誤，讓程式停止執行，避免使用未驗證的憑證
}
const httpsAgent = new https.Agent({
    ca: [
        gdig2,
        caCert
    ] // 將 CA 憑證添加到選項中
});
const instance = axios.create({
    httpsAgent: httpsAgent
});

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
            if (text === 'register') {
                const card = {
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        {
                            type: 'TextBlock',
                            text: '請輸入您的名字',
                            weight: 'Bolder',
                            size: 'Medium'
                        },
                        {
                            type: 'Input.Text',
                            id: 'userInput',
                            placeholder: '輸入你的名字'
                        },
                        {
                            type: 'Input.Text',
                            id: 'userEmail',
                            placeholder: '輸入您的 Email',
                            style: 'email'
                        }
                    ],
                    actions: [
                        {
                            type: 'Action.Submit',
                            title: '送出',
                            data: { action: 'submitName' }
                        }
                    ]
                };
                await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });
            } else if (context.activity.value && context.activity.value.action === 'submitName') {
                const userName = context.activity.value.userInput;
                await context.sendActivity(`你輸入的名字是：${userName}`);
                const conversationReference = TurnContext.getConversationReference(context.activity);
                this.conversationReferences[context.activity.from.id] = conversationReference;
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
                    // const userName = context.activity.from.name;
                    // await context.sendActivity(`HI, ${userName}`);
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
                    const threadResponse = await instance({
                        method: 'POST',
                        url: `${SCM_API_BASE_ENDPOINT}/v2/threads`,
                        headers: {
                            'SCM_API_KEY': SCM_API_KEY,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            "thread_id": "thread_123",
                            "messages": [
                                // {
                                //     "content": "You will add the emoji end of the response.",
                                //     "role": "user"
                                // }
                            ]
                        },
                        // httpsAgent: agent
                    });
                    
                    if (threadResponse.status !== 200) {
                        throw new Error(`創建 thread 失敗: ${threadResponse.statusText}`);
                    }
                    const threadData = threadResponse.data;
                    const threadId = threadData.id;
                    // const threadId = TEST_THREAD_ID;

                    // 2. Send user message in thread
                    const userMessage = context.activity.text;
                    const messageResponse = await instance({
                        method: 'POST',
                        url: `${SCM_API_BASE_ENDPOINT}/v2/threads/${threadId}/messages`,
                        headers: {
                            'SCM_API_KEY': SCM_API_KEY,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            content: userMessage,
                            message_role: 'user',
                            auth_role: 'Default'
                        },
                        // httpsAgent: agent
                    });
                    
                    if (messageResponse.status !== 200) {
                        throw new Error(`發送消息失敗: ${messageResponse.statusText}`);
                    }
                    // 3. Create run
                    const runResponse = await instance({
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
                        responseType: 'stream',
                        // httpsAgent: agent
                    });
                    
                    if (runResponse.status !== 200) {
                        throw new Error(`創建 run 失敗: ${runResponse.statusText}`);
                    }

                    // Process stream response
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
            // console.log('Members Added:', context.activity);
            const membersAdded = context.activity.membersAdded;
            for (let member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(`歡迎加入 Teams Bot！`);
                    
                    // Save conversation reference for new member
                    const ref = TurnContext.getConversationReference(context.activity);
                    this.conversationReferences[member.id] = ref;
                    break;
                }
            }
            await next();
        });
    }
}

// Proactive message function
async function sendProactiveMessage(adapter, conversationReferences, MicrosoftAppId) {
    for (const userId in conversationReferences) {
        console.log('Send to:', userId);
        console.log('conversationReferences', conversationReferences);
        const ref = conversationReferences[userId];
        console.log('ref', ref);
        await adapter.continueConversationAsync(MicrosoftAppId, ref, async (turnContext) => {
            await turnContext.sendActivity('這是一條主動通知訊息！');
        });
    }
    console.log("-----------------------------")
}

// Create bot instance
const bot = new TeamsBot(adapter);

// Create server
const server = restify.createServer();
server.use(restify.plugins.bodyParser());

// Add proactive notification endpoint
server.post('/api/notify', async (req, res) => {
    const appId = req.headers['microsoft_app_id'];
    await sendProactiveMessage(adapter, conversationReferences, appId);
    res.send(200, '通知已發送');
});

// Middleware to handle OPTIONS requests
server.opts('/api/messages', function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.send(200);
    next();
});

// Configure server message endpoint
server.post('/api/messages', async (req, res) => {
    // verify token
    // const authHeader = req.headers['authorization'] || '';
    // if (authHeader) {
    //     const token = authHeader.replace('Bearer ', '');
    //     try {
    //         const decodedToken = jwt.decode(token, { complete: true });
    //         // console.log("Decoded token:", JSON.stringify(decodedToken, null, 2));
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
