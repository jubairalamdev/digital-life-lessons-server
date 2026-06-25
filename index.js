const dns = require("node:dns");
dns.setServers(['8.8.8.8', '8.8.4.4'])

require('dotenv').config();

const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express()
const port = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

const uri = process.env.MONGO_DB_URI;

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

        app.get('/api/lessons/free', async (req, res) => {
            const cursor = lessonsCollection.find({
                accessLevel: "Free"
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