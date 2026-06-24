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
                console.error("Error fetching top contributors:", error);
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

        app.get('/api/lessons/:lessonId', async (req, res) => {
            const lessonId = req.params.lessonId;
            const lesson = await lessonsCollection.findOne({ _id: new ObjectId(lessonId) });
            res.send(lesson)
        })


        app.post('/api/comments', async(req,res)=> {
            const comment = req.body;
            const result = await commentsCollection.insertOne(comment);
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