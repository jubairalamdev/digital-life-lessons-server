const dns = require("node:dns");
dns.setServers(['8.8.8.8', '8.8.4.4'])

const express = require('express')
const cors = require('cors')

const app = express()
const port = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
    res.send('The Root of Server is here')
})

app.listen(port, () => {
    console.log(`Server listening on port ${port}`)
})