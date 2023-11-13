const AWS = require('aws-sdk');
AWS.config.update({ region: 'ap-southeast-2' });
const s3 = new AWS.S3();

async function downloadFromS3(bucket, key) {
    const params = {
        Bucket: bucket,
        Key: key
    };
    const data = await s3.getObject(params).promise();
    return data.Body.toString('utf-8');
}

async function uploadToS3(bucket, key, body) {
    const params = {
        Bucket: bucket,
        Key: key,
        Body: body
    };
    await s3.putObject(params).promise();
}
module.exports = { downloadFromS3, uploadToS3 };