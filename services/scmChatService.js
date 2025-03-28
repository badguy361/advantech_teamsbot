const axios = require('axios');

class SCMChatService {
    constructor(config) {
        this.SCM_API_BASE_ENDPOINT = config.scm.SCM_API_BASE_ENDPOINT;
        this.SCM_API_KEY = config.scm.SCM_API_KEY;
        this.SCM_ASSISTANT_ID = config.scm.SCM_ASSISTANT_ID;
    }

    async handleChatMessage(context) {
        try {
            const userMessage = context.activity.text;
            const userAuthRole = 'Default'; // TODO: process auth_role
            const response = await this.processChatFlow(userMessage, userAuthRole);
            return response;
        } catch (error) {
            console.error('聊天處理錯誤:', error);
            return "聊天處理錯誤";
        }
    }

    async processChatFlow(userMessage, userAuthRole) {
        const threadData = await this.createThread();
        const threadId = threadData.id;

        const status = await this.createMessage(userMessage, threadId, userAuthRole);

        const finalContent = await this.createRun(threadId);

        return finalContent
    }

    async createThread() {
        const response = await axios({
            method: 'POST',
            url: `${this.SCM_API_BASE_ENDPOINT}/v2/threads`,
            headers: this.getHeaders(),
            data: {
                "thread_id": "thread_123",
                "messages": []
            }
        });

        if (response.status !== 200) {
            throw new Error(`創建 thread 失敗: ${response.statusText}`);
        }
        return response.data;
    }

    async createMessage(userMessage, threadId, userAuthRole) {
        const messageResponse = await axios({
            method: 'POST',
            url: `${this.SCM_API_BASE_ENDPOINT}/v2/threads/${threadId}/messages`,
            headers: this.getHeaders(),
            data: {
                content: userMessage,
                message_role: 'user',
                auth_role: userAuthRole
            }
        });
        
        if (messageResponse.status !== 200) {
            throw new Error(`發送消息失敗: ${messageResponse.statusText}`);
        }
        return messageResponse.status
    }

    async createRun(threadId) {
        const runResponse = await axios({
            method: 'post',
            url: `${this.SCM_API_BASE_ENDPOINT}/v2/threads/${threadId}/runs`,
            headers: this.getHeaders(),
            data: {
                assistant_id: this.SCM_ASSISTANT_ID,
                stream: true
            },
            responseType: 'stream'
        });
        
        if (runResponse.status !== 200) {
            throw new Error(`創建 run 失敗: ${runResponse.statusText}`);
        }

        // Process stream response
        // TODO: don't use stream response, use async await to get final message
        return new Promise((resolve, reject) => {
            let currentEvent = null;
            let finalContent;
    
            runResponse.data.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEvent = line.replace('event: ', '').trim();
                    } else if (line.startsWith('data: ')) {
                        const dataStr = line.replace('data: ', '').trim();
                        try {
                            if (currentEvent === 'thread.message.completed') {
                                const data = JSON.parse(dataStr);
                                finalContent = data.content[0].text.value;
                                console.log("finalContent", finalContent);
                            }
                            if (currentEvent === 'error') {
                                console.error('Stream error from server:', dataStr);
                                reject(new Error('Stream error from server'));
                            }
                        } catch (error) {
                            console.error(`Error parsing ${currentEvent} data:`, error);
                            reject(new Error('Error parsing data'));
                        }
                    }
                }
            });
    
            runResponse.data.on('end', () => {
                console.log('Stream connection closed');
                if (finalContent) {
                    resolve(finalContent);
                } else {
                    reject(new Error('No final content received'));
                }
            });
        });
    }

    getHeaders() {
        return {
            'SCM_API_KEY': this.SCM_API_KEY,
            'Content-Type': 'application/json'
        }
    }
}

module.exports = SCMChatService;