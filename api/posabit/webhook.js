export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  let body = "";
  await new Promise((resolve) => {
    req.on("data", (chunk) => (body += chunk));
    req.on("end", resolve);
  });

  try {
    const parsed = JSON.parse(body);
    console.log("POSaBIT webhook:", parsed);
  } catch (err) {
    console.log("POSaBIT webhook (raw):", body);
  }

  return res.status(200).json({ ok: true });
}
