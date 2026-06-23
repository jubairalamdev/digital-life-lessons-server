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

        app.get('/api/lessons/free', async (req, res) => {
            const cursor = lessonsCollection.find({
                accessLevel: "Free"
            });
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

        app.get('/api/users/:userId', async(req,res)=> {
            const userId = req.params.userId;
            const user = await usersCollection.findOne({ _id: new ObjectId(userId)});
            res.send(user)
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