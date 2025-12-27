import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SECRET";

// ---------- Helpers ----------
function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user?.role) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

async function getWarehouseId(code) {
  const wh = await prisma.warehouse.findUnique({ where: { code } });
  if (!wh) throw new Error("Warehouse not found: " + code);
  return wh.id;
}

async function getProductByCode(code) {
  const p = await prisma.product.findUnique({ where: { code } });
  if (!p) throw new Error("Product not found: " + code);
  return p;
}

async function getInv(warehouseId, productId) {
  const inv = await prisma.inventory.findUnique({
    where: { warehouseId_productId: { warehouseId, productId } },
  });
  return inv ? inv.qty : 0;
}

async function applyTx(txType, warehouseId, productId, qty, userId) {
  await prisma.inventoryTx.create({
    data: { txType, warehouseId, productId, qty, userId },
  });

  await prisma.inventory.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    update: { qty: { increment: qty } },
    create: { warehouseId, productId, qty },
  });
}

// ---------- Routes ----------
app.get("/", (req, res) => res.json({ ok: true, name: "warehouse-backend" }));

// Auth: login
app.post("/auth/login", async (req, res) => {
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

  const { username, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken(user);
  res.json({ accessToken: token, role: user.role, username: user.username, name: user.name });
});

// Admin: create user (اختیاری، برای بعد)
app.post("/admin/users", auth, requireRole("admin"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    username: z.string().min(3),
    role: z.enum(["admin","sales","warehouse","supply"]),
    password: z.string().min(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, username, role, password } = parsed.data;
  const hash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: { name, username, role, passwordHash: hash },
  });

  res.json({ id: user.id, username: user.username, role: user.role, name: user.name });
});

// Production (warehouse/admin)
app.post("/production", auth, requireRole("warehouse", "admin"), async (req, res) => {
  const schema = z.object({
    productCode: z.string().min(1),
    gallonSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    count: z.number().int().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { productCode, gallonSize, count } = parsed.data;
  const liters = count * gallonSize;

  // Fixed warehouses for your business
  const RAW_WH = await getWarehouseId("RAW_WH");
  const GAL_WH = await getWarehouseId("GAL_WH");
  const FG_WH = await getWarehouseId("FG_WH");

  // Load formula kg/L
  const formula = await prisma.formulaPerLiter.findMany({ where: { productCode } });
  if (formula.length === 0) return res.status(400).json({ error: "Formula not defined" });

  // Check raw material stock (kg)
  for (const f of formula) {
    const raw = await getProductByCode(f.rawCode);
    const needKg = f.kgPerLiter * liters;
    const avail = await getInv(RAW_WH, raw.id);
    if (avail < needKg) {
      return res.status(400).json({
        error: `کمبود ماده ${f.rawCode}`,
        details: { needKg, availKg: avail }
      });
    }
  }

  // Check empty gallons stock (count)
  const gallonProd = await getProductByCode(`GALLON_${gallonSize}`);
  const availG = await getInv(GAL_WH, gallonProd.id);
  if (availG < count) {
    return res.status(400).json({
      error: `کمبود گالن ${gallonSize}`,
      details: { need: count, available: availG }
    });
  }

  const userId = Number(req.user.sub);

  // Consume raw materials
  const consumed = [];
  for (const f of formula) {
    const raw = await getProductByCode(f.rawCode);
    const needKg = f.kgPerLiter * liters;
    await applyTx("PRODUCTION", RAW_WH, raw.id, -needKg, userId);
    consumed.push({ raw: f.rawCode, kg: needKg });
  }

  // Consume empty gallons
  await applyTx("PRODUCTION", GAL_WH, gallonProd.id, -count, userId);

  // Add final products to FG warehouse: PACK + LITERS
  const pack = await getProductByCode(`${productCode}_PACK_${gallonSize}`);
  const litersProd = await getProductByCode(`${productCode}_LITERS`);
  await applyTx("PRODUCTION", FG_WH, pack.id, +count, userId);
  await applyTx("PRODUCTION", FG_WH, litersProd.id, +liters, userId);

  res.json({ ok: true, productCode, gallonSize, count, liters, consumed });
});

// Purchases (supply/admin) — only raw + empty gallons
app.post("/purchases", auth, requireRole("supply", "admin"), async (req, res) => {
  const schema = z.object({
    items: z.array(z.object({
      code: z.string().min(1),
      qty: z.number().positive()
    })).min(1)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const RAW_WH = await getWarehouseId("RAW_WH");
  const GAL_WH = await getWarehouseId("GAL_WH");
  const userId = Number(req.user.sub);

  for (const it of parsed.data.items) {
    const p = await getProductByCode(it.code);

    // Route to correct warehouse
    const whId = (p.type === "RAW") ? RAW_WH
              : (p.type === "GALLON") ? GAL_WH
              : null;

    if (!whId) return res.status(400).json({ error: `کد خرید غیرمجاز: ${it.code}` });

    await applyTx("PURCHASE", whId, p.id, +it.qty, userId);
  }

  res.json({ ok: true });
});

// Sales (sales/admin) — only from FG warehouse, only PACK sizes (no half gallon)
app.post("/sales", auth, requireRole("sales", "admin"), async (req, res) => {
  const schema = z.object({
    productCode: z.string().min(1),
    gallonSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    count: z.number().int().positive()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { productCode, gallonSize, count } = parsed.data;
  const liters = count * gallonSize;

  const FG_WH = await getWarehouseId("FG_WH");
  const userId = Number(req.user.sub);

  const pack = await getProductByCode(`${productCode}_PACK_${gallonSize}`);
  const litersProd = await getProductByCode(`${productCode}_LITERS`);

  const availPack = await getInv(FG_WH, pack.id);
  const availLit = await getInv(FG_WH, litersProd.id);

  if (availPack < count) {
    return res.status(400).json({ error: "موجودی بسته کافی نیست", details: { available: availPack, need: count } });
  }
  if (availLit < liters) {
    // Should not happen if system consistent, but keep safe
    return res.status(400).json({ error: "موجودی لیتری کافی نیست", details: { available: availLit, need: liters } });
  }

  await applyTx("SALE", FG_WH, pack.id, -count, userId);
  await applyTx("SALE", FG_WH, litersProd.id, -liters, userId);

  res.json({ ok: true, productCode, gallonSize, count, liters });
});

// Inventory summary: raw kg + empty gallons + products (liters + pack counts)
app.get("/inventory/summary", auth, async (req, res) => {
  const RAW_WH = await getWarehouseId("RAW_WH");
  const GAL_WH = await getWarehouseId("GAL_WH");
  const FG_WH = await getWarehouseId("FG_WH");

  const inv = await prisma.inventory.findMany({
    include: { product: true, warehouse: true }
  });

  const rawKg = {};
  const gallonsEmpty = { "5": 0, "10": 0, "20": 0 };
  const productsMap = new Map(); // code -> { code, liters, pack:{5,10,20} }

  for (const row of inv) {
    const code = row.product.code;
    const wh = row.warehouse.code;

    if (wh === "RAW_WH" && row.product.type === "RAW") {
      rawKg[code] = row.qty;
    }

    if (wh === "GAL_WH" && row.product.type === "GALLON") {
      if (code === "GALLON_5") gallonsEmpty["5"] = row.qty;
      if (code === "GALLON_10") gallonsEmpty["10"] = row.qty;
      if (code === "GALLON_20") gallonsEmpty["20"] = row.qty;
    }

    if (wh === "FG_WH") {
      // productCode is prefix before _
      const m = code.match(/^([A-Z0-9]+)_(PACK_(5|10|20)|LITERS)$/);
      if (!m) continue;
      const pcode = m[1];

      if (!productsMap.has(pcode)) {
        productsMap.set(pcode, { code: pcode, liters: 0, pack: { "5": 0, "10": 0, "20": 0 } });
      }
      const obj = productsMap.get(pcode);

      if (code.endsWith("_LITERS")) obj.liters = row.qty;
      if (code.endsWith("_PACK_5")) obj.pack["5"] = row.qty;
      if (code.endsWith("_PACK_10")) obj.pack["10"] = row.qty;
      if (code.endsWith("_PACK_20")) obj.pack["20"] = row.qty;
    }
  }

  res.json({
    rawKg,
    gallonsEmpty,
    products: Array.from(productsMap.values()).sort((a,b) => a.code.localeCompare(b.code))
  });
});

// Active alerts
app.get("/alerts/active", auth, async (req, res) => {
  const rules = await prisma.alertRule.findMany();

  const results = [];
  for (const r of rules) {
    const wh = await prisma.warehouse.findUnique({ where: { code: r.warehouseCode } });
    const pr = await prisma.product.findUnique({ where: { code: r.productCode } });
    if (!wh || !pr) continue;

    const current = await prisma.inventory.findUnique({
      where: { warehouseId_productId: { warehouseId: wh.id, productId: pr.id } }
    });

    const qty = current ? current.qty : 0;
    if (qty < r.minQty) {
      results.push({
        warehouse: wh.name,
        product: pr.code,
        current: qty,
        min: r.minQty,
        unit: pr.unit
      });
    }
  }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`✅ Backend listening on :${PORT}`);
});
