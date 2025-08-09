export const config = { api: { bodyParser: false } };

async function sbSelect(path) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase select failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const lookback = Math.max(1, Number(url.searchParams.get("lookback") || 14));
    const lead = Math.max(0, Number(url.searchParams.get("lead") || 7));
    const safety = Math.max(0, Number(url.searchParams.get("safety") || 3));

    const since = new Date(); since.setDate(since.getDate() - lookback);
    const sales = await sbSelect(`sales_lines?select=sku,qty,ts&ts=gte.${encodeURIComponent(since.toISOString())}`);
    const inv   = await sbSelect(`inventory_levels?select=sku,on_hand,updated_at`);
    const prods = await sbSelect(`products?select=sku,name,vendor,cost`);

    const sumBySku = new Map();
    for (const s of sales) if (s.sku) sumBySku.set(s.sku, (sumBySku.get(s.sku) || 0) + Number(s.qty || 0));
    const invBySku = new Map(inv.map(i => [i.sku, i]));
    const prodBySku = new Map(prods.map(p => [p.sku, p]));
    const allSkus = new Set([...sumBySku.keys(), ...invBySku.keys()]);

    const rows = [];
    for (const sku of allSkus) {
      const totals = sumBySku.get(sku) || 0;
      const daily = totals / lookback;
      const invRow = invBySku.get(sku) || { on_hand: 0, updated_at: null };
      const prod = prodBySku.get(sku) || { name: null, vendor: null, cost: null };

      const reorderDays = lead + safety;
      const target = daily * reorderDays;
      const orderQty = Math.max(0, Math.ceil(target - Number(invRow.on_hand || 0)));
      const dos = daily > 0 ? Number((Number(invRow.on_hand || 0) / daily).toFixed(1)) : null;

      rows.push({
        sku, name: prod.name, vendor: prod.vendor,
        on_hand: Number(invRow.on_hand || 0),
        daily_rate: Number(daily.toFixed(3)),
        days_of_supply: dos,
        reorder_point_days: reorderDays,
        target_stock: Math.ceil(target),
        order_qty: orderQty,
        unit_cost: prod.cost,
        est_cost: prod.cost ? Number((prod.cost * orderQty).toFixed(2)) : null,
        last_inventory_update: invRow.updated_at,
      });
    }

    rows.sort((a,b) => (a.days_of_supply ?? 1e9) - (b.days_of_supply ?? 1e9) || b.order_qty - a.order_qty);
    res.status(200).json({ lookback, lead, safety, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
