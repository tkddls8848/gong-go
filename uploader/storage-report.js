// R2 저장량을 실제 객체 크기로 집계한다. 데이터와 버킷 설정은 수정하지 않는다.
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { endpoint } = require("./upload");
async function main() {
  const client = new S3Client({ region: "auto", endpoint: endpoint(), credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  } });
  const groups = {}, months = {};
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: "gong-go-data", ContinuationToken: token }));
    for (const object of page.Contents || []) {
      const group = object.Key.startsWith("raw/") ? "raw" : /^(pre|bid|plan)\//.test(object.Key) ? "service" : "other";
      const item = groups[group] ||= { count: 0, bytes: 0 };
      item.count++; item.bytes += object.Size;
      const match = /^(?:raw\/)?(?:pre|bid|plan)\/(\d{4})\/(\d{2})/.exec(object.Key);
      if (match) {
        const month = months[`${group}/${match[1]}-${match[2]}`] ||= { count: 0, bytes: 0 };
        month.count++; month.bytes += object.Size;
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  console.log(JSON.stringify({ bucket: "gong-go-data", groups, months }, null, 2));
}
main().catch((error) => { console.error(error.message || error.name); process.exitCode = 1; });
