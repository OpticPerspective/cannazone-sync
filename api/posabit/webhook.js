// api/posabit/webhook.js
export const config = { api: { bodyParser: false } };

// ---------- Supabase helpers (REST, no extra libs) ----------
async function sbInsert(table, rows) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Insert ${table} failed: ${res.status} ${await res.text()}`);
}

async function sbUpsert(table, rows, onConflict) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Upsert ${table} failed: ${res.status} ${await res.text()}`);
}

// ---------- Webhook handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method not allowed" });

  // Read raw body (keeps signature options open later)
  let body = "";
  await new Promise(r => { req.on("data", c => body += c); req.on("end", r); });

  let evt;
  try { evt = JSON.parse(body); } catch { evt = { raw: body }; }

  // Extract sale id + line items from common POSaBIT shapes
  const saleId = evt?.sale?.id ?? evt?.sale_id ?? evt?.id ?? "";

  // Most POSaBIT payloads nest line items under sale.line_items; keep fallbacks
  const items = evt?.sale?.line_items ?? evt?.items ?? evt?.line_items ?? [];

  // Normalize lines -> { sku, qty, name?, vendor? }
  const lines = items.map(li => {
    const product = li?.product || {};
    const sku =
      product?.sku ??
      li?.sku ??
      li?.SKU ??
      li?.product_sku ??
      ""; // required
    const qty = Number(li?.quantity ?? li?.qty ?? 0);
    const name = product?.name ?? li?.name ?? null;
    const vendor = product?.brand ?? product?.vendor ?? null;
    return { sku, qty, name, vendor };
  }).filter(x => x.sku && x.qty > 0);

  if (lines.length === 0) {
    console.log("POSaBIT webhook received but no mappable line items:", evt);
    return res.status(200).json({ ok: true, received: 0 });
  }

  const ts = new Date().toISOString();

  // Build sales_lines rows (append-only)
  const salesRows = lines.map(l => ({
    posabit_sale_id: String(saleId),
    sku: l.sku,
    qty: l.qty,
    ts,
    raw: evt        // keep full payload for audit / mapping tweaks
  }));

  // Opportunistically upsert minimal product master data (by sku)
  const productRows = lines
    .filter(l => l.name || l.vendor)
    .map(l => ({
      sku: l.sku,
      name: l.name,
      vendor: l.vendor
    }));

  try {
    if (productRows.length) await sbUpsert("products", productRows, "sku");
    await sbInsert("sales_lines", salesRows);
    console.log(`Stored ${salesRows.length} sales_lines for sale ${saleId}`);
    return res.status(200).json({ ok: true, inserted: salesRows.length });
  } catch (err) {
    console.error("Supabase write error:", err.message);
    // Still 200 so POSaBIT doesn't retry-bomb; we'll fix mapping if needed
    return res.status(200).json({ ok: false, error: "insert failed; check logs" });
  }
}
