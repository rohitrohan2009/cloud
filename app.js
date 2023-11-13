require('dotenv').config();
console.log(`Loaded PORT: ${process.env.PORT}`);
const express = require('express');
const AWS = require('aws-sdk');
const { parse } = require('csv-parse/sync');
const aposToLexForm = require('apos-to-lex-form');
const natural = require('natural');
const path = require('path');
const SpellCorrector = require('spelling-corrector');
const stopword = require('stopword');
const { downloadFromS3, uploadToS3 } = require('./s3Config');

const app = express();
const BUCKET_NAME = process.env.BUCKET_NAME;

AWS.config.update({ region: process.env.AWS_REGION });
const s3 = new AWS.S3({ apiVersion: '2006-03-01' });

const tokenizer = new natural.WordTokenizer();
const Analyzer = natural.SentimentAnalyzer;
const stemmer = natural.PorterStemmer;
const analyzer = new Analyzer("English", stemmer, "afinn");
const spellCorrector = new SpellCorrector();
spellCorrector.loadDictionary();
const redis = require('redis');

const redisClient = redis.createClient({
  host: 'rohit-11130130-2.km2jzi.clustercfg.apse2.cache.amazonaws.com',
  port: 6379
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect();

app.use('/image', express.static(path.join(__dirname, 'image')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
const analysisSentiment = function (message) {
    let cleanedText = aposToLexForm(message).toLowerCase().replace(/[^a-zA-Z\s]+/g, "");
    const tokenized = tokenizer.tokenize(cleanedText);
    const fixedSpelling = tokenized.map(word => spellCorrector.correct(word));
    const stopWordsRemoved = stopword.removeStopwords(fixedSpelling);
    return analyzer.getSentiment(stopWordsRemoved);
};

const analyzeTweets = async (searchTerm) => {
    const csvContent = await downloadFromS3(BUCKET_NAME, 'tweet.csv');
    const records = parse(csvContent, { columns: true, skip_empty_lines: true });

    let sentimentResults = [];
    let count = 0;
    const searchTermRegex = new RegExp(`\\b${searchTerm}\\b`, 'i');

    for (const row of records) {
        if (count >= 50) break;
        const tweetText = row.tweet.toLowerCase();
        if (searchTermRegex.test(tweetText)) {
            count++;
            const sentiment = analysisSentiment(row.tweet);
            sentimentResults.push({ username: row.username, tweet: row.tweet, sentiment: sentiment });
        }
    }

    return sentimentResults;
};

const createCsvString = (results) => {
    // CSV header
    let csvString = 'tweet,sentiment\n';

    // Iterate over the results and create a CSV row for each
    results.forEach(row => {
        // Replace any existing double quotes in the tweet with two double quotes (standard CSV escaping)
        const tweet = row.tweet.replace(/"/g, '""');

        // Enclose the tweet in double quotes and append the sentiment
        // This will handle any commas or new lines within the tweets
        csvString += `"${tweet}",${row.sentiment}\n`;
    });

    return csvString;
};

function calculateAverageSentiment(records) {
  return records.reduce((acc, curr) => acc + parseFloat(curr.sentiment), 0) / records.length;
}

function sendSentimentResponse(res, averageSentiment, dataSource) {
  let image = averageSentiment > 0.5 ? '/image/image1.jpg' : averageSentiment <= -0.5 ? '/image/image2.jpg' : '/image/image3.jpg';
  res.json({ averageSentiment: averageSentiment, image: image, dataSource: dataSource });
}

app.get('/sentiment', async (req, res) => {
  const searchTerm = req.query.search.toLowerCase();
  const resultsFileName = `${searchTerm}.csv`;

  try {
    // First, check if the results are cached in Redis
    const cacheResults = await redisClient.get(searchTerm);
    if (cacheResults) {
      // Parse and send the response
      const records = parse(cacheResults, { columns: true, skip_empty_lines: true });
      const averageSentiment = calculateAverageSentiment(records);
      return sendSentimentResponse(res, averageSentiment, 'redis');
    }

    // If not in Redis, try to get the object from S3
    const s3Params = { Bucket: BUCKET_NAME, Key: resultsFileName };
    const data = await s3.getObject(s3Params).promise();
    const s3CsvContent = data.Body.toString('utf-8');
    const s3Records = parse(s3CsvContent, { columns: true, skip_empty_lines: true });
    const s3AverageSentiment = calculateAverageSentiment(s3Records);

    // Cache the S3 results in Redis
    await redisClient.set(searchTerm, s3CsvContent, 'EX', 3600); // expire after 1 hour

    return sendSentimentResponse(res, s3AverageSentiment, 's3');
  } catch (error) {
    if (error.code === 'NoSuchKey') {
      // If the object does not exist, analyze and upload to S3 and Redis
      const results = await analyzeTweets(searchTerm);
      if (results.length === 0) {
        return res.status(404).send('No tweets found for the given search term.');
      }

      const csvString = createCsvString(results);
      const averageSentiment = calculateAverageSentiment(results);

      // Save the CSV to S3
      await uploadToS3(BUCKET_NAME, resultsFileName, csvString);
      // Cache the results in Redis
      await redisClient.set(searchTerm, csvString, 'EX', 3600); // expire after 1 hour

      return sendSentimentResponse(res, averageSentiment, 'new');
    } else {
      console.error('Error:', error);
      return res.status(500).send('Error processing request');
    }
  }
});
const port = process.env.PORT || 3001;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});