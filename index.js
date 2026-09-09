const dns = require("node:dns");
dns.setServers(['8.8.8.8', '8.8.4.4'])

require('dotenv').config();

const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const OpenAI = require('openai');

const app = express()
const port = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

const uri = process.env.MONGO_DB_URI;

// AI chat provider — OpenRouter (OpenAI-compatible). Falls back to a direct
// OpenAI key if no OpenRouter key is configured.
const AI_API_KEY = process.env.OPEN_ROUTER_API_KEY || process.env.OPENAI_API_KEY;
const AI_BASE_URL = process.env.OPENROUTER_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'https://openrouter.ai/api/v1';
const AI_MODEL = process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'openai/gpt-4o-mini';

const aiClient = AI_API_KEY
    ? new OpenAI({
        apiKey: AI_API_KEY,
        baseURL: AI_BASE_URL,
        defaultHeaders: {
            'HTTP-Referer': process.env.SITE_URL || 'https://digital-life-lessons.vercel.app',
            'X-Title': process.env.SITE_NAME || 'Digital Life Lessons',
        },
    })
    : null;

// In-memory rate limiting for the AI chat route (per server instance).
const chatLimits = new Map();
const CHAT_LIMIT = 20;
const CHAT_WINDOW_MS = 60 * 1000;

function chatRateLimit(key) {
    const now = Date.now();
    const record = chatLimits.get(key);
    if (!record || now - record.resetAt >= CHAT_WINDOW_MS) {
        chatLimits.set(key, { count: 1, resetAt: now + CHAT_WINDOW_MS });
        return { ok: true, remaining: CHAT_LIMIT - 1 };
    }
    if (record.count >= CHAT_LIMIT) {
        return { ok: false, remaining: 0, retryAfterSec: Math.ceil((record.resetAt - now) / 1000) };
    }
    record.count += 1;
    return { ok: true, remaining: CHAT_LIMIT - record.count };
}

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';
}

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

app.get('/', (req, res) => {
    res.send('The Root of Server is here')
})

async function run() {
    try {
        // Connect the Client with Cluster
        await client.connect();

        // Connect with Database from Cluster
        const db = client.db("digital-life-lessons");

        // Connect with Collection from Database
        const lessonsCollection = db.collection("lessons");
        const usersCollection = db.collection("user");
        const commentsCollection = db.collection("comments");
        const favoritesCollection = db.collection("favorites");
        const reportsCollection = db.collection("reports");

        app.get('/api/lessons/free', async (req, res) => {
            const cursor = lessonsCollection.find({
                isFeatured: true
            });
            const result = await cursor.toArray();
            res.send(result)
        })

        app.get('/api/lessons', async (req, res) => {
            const cursor = lessonsCollection.find();
            const result = await cursor.toArray();
            res.send(result)
        })

        // GET /api/lessons/top-contributors
        app.get('/api/lessons/top_contributors', async (req, res) => {
            try {
                const topContributors = await lessonsCollection.aggregate([
                    {
                        $group: {
                            _id: "$creatorId",
                            totalLessons: { $sum: 1 }
                        }
                    },
                    {
                        $sort: { totalLessons: -1 }
                    },
                    {
                        $limit: 5
                    }
                ]).toArray();

                res.send(topContributors);
            } catch (error) {
                // console.error("Error fetching top contributors:", error);
                res.status(500).json({ message: "Internal server error" });
            }
        });

        app.post('/api/reports', async (req, res) => {
            try {
                const reportData = req.body;
                const result = await reportsCollection.insertOne(reportData);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error submitting report:", error);
                res.status(500).json({ error: "Failed to submit report" });
            }
        });

        // POST /api/ai/chat — OpenRouter-backed lesson assistant (server-side proxy)
        // Supports both plain JSON (default) and SSE streaming (req.body.stream === true)
        app.post('/api/ai/chat', async (req, res) => {
            try {
                const rate = chatRateLimit(clientIp(req));
                if (!rate.ok) {
                    return res.status(429).json({
                        error: "Too many requests. Please try again shortly.",
                        retryAfterSec: rate.retryAfterSec
                    });
                }

                if (!aiClient) {
                    return res.status(503).json({ error: "AI assistant is not configured on the server." });
                }

                const { messages, lesson } = req.body;
                const wantStream = req.body?.stream === true;

                if (!Array.isArray(messages) || messages.length === 0) {
                    return res.status(400).json({ error: "Messages must be a non-empty array." });
                }

                const sanitized = messages
                    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                    .slice(-10)
                    .map((m) => ({ role: m.role, content: m.content }));

                if (sanitized.length === 0) {
                    return res.status(400).json({ error: "No valid message content provided." });
                }

                const systemPrompt = lesson && lesson.title
                    ? `You are Digital Life Lessons, a supportive mentor helping users reflect on life lessons. The user is reading the lesson "${lesson.title}". Keep answers empathetic, concise, and grounded in practical advice.`
                    : "You are Digital Life Lessons, a supportive mentor helping users reflect on life lessons. Keep answers empathetic, concise, and grounded in practical advice.";

                const completion = await aiClient.chat.completions.create({
                    model: AI_MODEL,
                    messages: [{ role: "system", content: systemPrompt }, ...sanitized],
                    max_tokens: 500,
                    stream: wantStream ? true : undefined,
                });

                // Streaming response (SSE)
                if (wantStream) {
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                    res.flushHeaders?.();

                    req.on("close", () => completion?.controller?.abort());

                    try {
                        for await (const chunk of completion) {
                            const delta = chunk?.choices?.[0]?.delta?.content;
                            if (delta) {
                                res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                            }
                        }
                    } catch (error) {
                        if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify({ error: "Stream interrupted." })}\n\n`);
                        }
                    }

                    if (!res.writableEnded) {
                        res.write("data: [DONE]\n\n");
                        res.end();
                    }
                    return;
                }

                const reply = completion.choices?.[0]?.message?.content?.trim();
                if (!reply) {
                    return res.status(502).json({ error: "The AI assistant returned an empty response." });
                }

                res.status(200).json({ reply });
            } catch (error) {
                console.error("Error in AI chat:", error);
                if (!res.headersSent) {
                    res.status(500).json({ error: "Failed to get a response from the AI assistant." });
                } else if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({ error: "Failed to get a response." })}\n\n`);
                    res.end();
                }
            }
        });

        app.get('/api/reports/check', async (req, res) => {
            try {
                const { lessonId, userId } = req.query;
                if (!lessonId || !userId) return res.status(400).send(null);

                const existingReport = await reportsCollection.findOne({
                    lessonId: lessonId,
                    reporterUserId: userId
                });

                res.send(existingReport); // Sends null if not found
            } catch (error) {
                res.status(500).send(null);
            }
        });

        app.get('/api/users/:userId', async (req, res) => {
            const userId = req.params.userId;
            const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
            res.send(user)
        })

        app.get('/api/my/lessons/:userId', async (req, res) => {
            const userId = req.params.userId;
            const cursor = lessonsCollection.find({
                creatorId: userId,
                visibility: "Public",
            });
            const result = await cursor.toArray();
            res.send(result)
        })

        app.get('/api/my/allLessons/:userId', async (req, res) => {
            const userId = req.params.userId;
            const cursor = lessonsCollection.find({
                creatorId: userId
            });
            const result = await cursor.toArray();
            res.send(result)
        })

        app.delete('/api/lessons/:lessonId', async (req, res) => {
            const lessonId = req.params.lessonId;
            const result = lessonsCollection.deleteOne({ _id: new ObjectId(lessonId) })
            // console.log(result)
            res.send(result)
        })

        app.get('/api/lessons/:lessonId', async (req, res) => {
            const lessonId = req.params.lessonId;
            const lesson = await lessonsCollection.findOne({ _id: new ObjectId(lessonId) })
            // console.log(lesson);
            res.send(lesson)
        })

        app.get('/api/comments/:lesson_id', async (req, res) => {
            const id = req.params.lesson_id;
            const cursor = await commentsCollection.find({ lessonId: id });
            const comments = await cursor.toArray()
            // console.log(comments)
            res.send(comments);
        })

        app.post('/api/comments', async (req, res) => {
            const comment = req.body;
            const result = await commentsCollection.insertOne(comment);
            res.send(result);
        })

        // Example of how your Express route should look:
        app.post('/api/favorites', async (req, res) => {
            try {
                const favorite = req.body;

                // Ensure your database collection handler is defined and ready
                if (!favoritesCollection) {
                    throw new Error("favoritesCollection database reference is not initialized!");
                }

                const result = await favoritesCollection.insertOne(favorite);
                res.status(201).send(result);
            } catch (error) {
                // console.error("❌ Error saving favorite to database:", error);
                res.status(500).json({ error: "Failed to save favorite record" });
            }
        });


        app.post('/api/lessons', async (req, res) => {
            try {
                const newLesson = req.body;
                const result = await lessonsCollection.insertOne(newLesson);

                if (result.insertedId) {
                    return res.status(201).json({
                        success: true,
                        message: "Lesson saved successfully",
                        insertedId: result.insertedId
                    });
                }

                throw new Error("Database insertion failed");
            } catch (error) {
                // console.error("Error creating lesson:", error);
                res.status(500).json({ message: "Internal server error" });
            }
        });


        app.get('/api/favorites/most-saved', async (req, res) => {
            try {
                const mostSaved = await favoritesCollection.aggregate([
                    {
                        $group: {
                            _id: "$lessonId",
                            countFavorites: { $sum: 1 }
                        }
                    },
                    {
                        $sort: { countFavorites: -1 }
                    },
                    {
                        $limit: 6
                    },
                    {
                        $project: {
                            _id: 0,
                            lessonId: "$_id",
                            countFavorites: 1
                        }
                    }
                ]).toArray();

                res.status(200).json(mostSaved);
            } catch (error) {
                // console.error("Aggregation error fetching most saved:", error);
                res.status(500).json({ message: "Internal server error" });
            }
        });


        app.get('/api/favorites/check', async (req, res) => {
            // console.log("requested.")
            try {
                const { userId, lessonId } = req.query;
                // console.log("user ====> ", userId)
                // console.log("lesson ====> ", lessonId)
                if (!userId || !lessonId) {
                    return res.status(400).json({ message: "Missing userId or lessonId parameters" });
                }

                const query = {
                    $or: [
                        { userId: userId, lessonId: lessonId },
                        {
                            userId: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
                            lessonId: ObjectId.isValid(lessonId) ? new ObjectId(lessonId) : lessonId
                        }
                    ]
                };

                const existingFavorite = await favoritesCollection.findOne(query);

                // console.log("favorite found? ====>", existingFavorite);

                if (!existingFavorite) {
                    return res.status(200).json(null);
                }

                res.status(200).send(existingFavorite);
            } catch (error) {
                // console.error("Database error while checking favorite status:", error);
                res.status(500).json({ message: "Internal server error" });
            }
        });



        app.get('/api/favorites/:UId', async (req, res) => {
            try {
                const { UId } = req.params;
                const cursor = favoritesCollection.find({
                    userId: UId
                });
                const favorites = await cursor.toArray();
                // console.log("Data from server ===>", favorites)
                res.send(favorites)
            } catch (error) {
                // console.error("Database error:", error);
                res.status(500).send({ error: "Internal server error" });
            }
        });

        app.patch('/api/lessons/:id', async (req, res) => {
            const id = req.params.id;
            const filter = {
                _id: new ObjectId(id)
            }
            const modifiedLesson = req.body;
            // console.log("Patching the data now =======> ", modifiedLesson)
            const updatedDocument = {
                $set: {
                    title: modifiedLesson.name,
                    description: modifiedLesson.description,
                    category: modifiedLesson.category,
                    emotionalTone: modifiedLesson.emotionalTone,
                    image: modifiedLesson.image,
                    visibility: modifiedLesson.visibility,
                    accessLevel: modifiedLesson.accessLevel,
                    isFeatured: modifiedLesson.isFeatured,
                    isReviewed: modifiedLesson.isReviewed,
                }
            }
            const result = await lessonsCollection.updateOne(filter, updatedDocument);
            // console.log("result now =======> ", result)
            res.send(result);
        })


        app.patch('/api/users/:id', async (req, res) => {
            const id = req.params.id;
            const filter = {
                _id: new ObjectId(id)
            }

            const modifiedUser = req.body;
            const updatedDocument = {
                $set: {
                    name: modifiedUser.name,
                    image: modifiedUser.image
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDocument);
            res.send(result);
        })

        app.patch('/api/users/upgrade/plan/:id', async (req, res) => {
            const id = req.params.id;
            const filter = {
                _id: new ObjectId(id)
            }

            const modifiedUser = req.body;
            const updatedDocument = {
                $set: {
                    plan: modifiedUser.plan
                }
            }
            // console.log("filtered ======> ", filter)
            // console.log("modifiedUser ======> ", updatedDocument)
            const result = await usersCollection.updateOne(filter, updatedDocument);
            res.send(result);
        })


        app.get('/api/users', async (req, res) => {
            const cursor = usersCollection.find({});
            const result = await cursor.toArray();
            res.send(result);
        })

        app.patch('/api/users/role/:id', async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDocument = {
                $set: { role: req.body.role }
            };
            const result = await usersCollection.updateOne(filter, updatedDocument);
            res.send(result);
        });

        app.patch('/api/lessons/toggle-featured/:id', async (req, res) => {
            const id = req.params.id;
            const { isFeatured } = req.body;
            const result = await lessonsCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { isFeatured: isFeatured } }
            );
            res.send(result);
        });

        app.patch('/api/lessons/toggle-reviewed/:id', async (req, res) => {
            const id = req.params.id;
            const { isReviewed } = req.body;
            const result = await lessonsCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { isReviewed: isReviewed } }
            );
            res.send(result);
        });


        app.patch('/api/lessons/like/:id', async (req, res) => {
            const id = req.params.id;
            const { userId } = req.body;

            try {
                const lesson = await lessonsCollection.findOne({ _id: new ObjectId(id) });
                if (!lesson) return res.status(404).send({ error: "Lesson not found" });

                const isLiked = lesson.likes && lesson.likes.includes(userId);

                let updateQuery;
                if (isLiked) {
                    updateQuery = { $pull: { likes: userId } };
                } else {
                    updateQuery = { $addToSet: { likes: userId } };
                }

                const result = await lessonsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    updateQuery
                );

                res.send({ success: true, action: isLiked ? 'unliked' : 'liked' });
            } catch (error) {
                res.status(500).send({ error: "Internal server error" });
            }
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

    } finally {
        // await client.close();
    }
}

run().catch(console.dir);

app.listen(port, () => {
    console.log(`Server listening on port ${port}`)
})