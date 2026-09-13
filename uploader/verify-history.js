// R2의 각 raw 일자가 실제 서비스 파일과 인덱스로 연결되는지 읽기 전용 검증한다.
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { endpoint } = require("./upload");
async function main() {
  const Bucket = "gong-go-data";
  const client = new S3Client({ region: "auto", endpoint: endpoint(), credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  } });
  const objects = new Map();
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }));
    for (const object of page.Contents || []) objects.set(object.Key, object.Size);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const response = await client.send(new GetObjectCommand({ Bucket, Key: "index.json" }));
  const index = JSON.parse(await response.Body.transformToString());
  const indexed = new Set(index.files.map((file) => file.path));
  const missing = index.files.filter((file) => !objects.has(file.path)).map((file) => file.path);
  const rawKeys = [...objects.keys()].filter((key) => /^raw\/(pre|bid|plan)\/\d{4}\/\d{2}\/\d{2}\.csv\.gz$/.test(key));
  for (const raw of rawKeys) {
    const daily = raw.slice(4), monthly = daily.replace(/\/\d{2}\.csv\.gz$/, ".csv.gz");
    if (!([daily, monthly].some((key) => objects.has(key) && indexed.has(key)))) missing.push(raw);
  }
  const dates = rawKeys.map((key) => key.slice(4).split("/").slice(1).join("-").replace(".csv.gz", "")).sort();
  const result = {
    bucket: Bucket, rawFiles: rawKeys.length, rawBytes: rawKeys.reduce((sum, key) => sum + objects.get(key), 0),
    rawBegin: dates[0], rawEnd: dates.at(-1), serviceFiles: index.files.length,
    serviceRows: index.files.reduce((sum, file) => sum + file.count, 0),
    serviceBegin: index.files.map((file) => file.begin).sort()[0],
    serviceEnd: index.files.map((file) => file.end).sort().at(-1), missing,
  };
  console.log(JSON.stringify(result, null, 2));
  if (missing.length || result.serviceBegin !== "2020-01-01") process.exitCode = 1;
}
main().catch((error) => { console.error(error.message || error.name); process.exitCode = 1; });
