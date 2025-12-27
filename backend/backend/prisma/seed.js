import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function upsertWarehouse(code, name) {
  return prisma.warehouse.upsert({
    where: { code },
    update: { name },
    create: { code, name },
  });
}

async function upsertProduct(code, name, type, unit) {
  return prisma.product.upsert({
    where: { code },
    update: { name, type, unit },
    create: { code, name, type, unit },
  });
}

async function upsertUser(name, username, role, password) {
  const hash = await bcrypt.hash(password, 10);
  return prisma.user.upsert({
    where: { username },
    update: { name, role, passwordHash: hash },
    create: { name, username, role, passwordHash: hash },
  });
}

async function setInv(warehouseCode, productCode, qty) {
  const wh = await prisma.warehouse.findUnique({ where: { code: warehouseCode } });
  const pr = await prisma.product.findUnique({ where: { code: productCode } });
  if (!wh || !pr) throw new Error("warehouse/product not found: " + warehouseCode + " / " + productCode);

  await prisma.inventory.upsert({
    where: { warehouseId_productId: { warehouseId: wh.id, productId: pr.id } },
    update: { qty },
    create: { warehouseId: wh.id, productId: pr.id, qty },
  });
}

async function main() {
  // 1) Warehouses
  await upsertWarehouse("RAW_WH", "انبار مواد اولیه");
  await upsertWarehouse("FG_WH", "انبار محصول تولید شده");
  await upsertWarehouse("GAL_WH", "انبار گالن");

  // 2) Raw materials (kg)
  for (const code of ["S", "P", "U", "C", "N"]) {
    await upsertProduct(code, code, "RAW", "kg");
  }

  // 3) Empty gallons (count)
  await upsertProduct("GALLON_5", "گالن 5 لیتری", "GALLON", "count");
  await upsertProduct("GALLON_10", "گالن 10 لیتری", "GALLON", "count");
  await upsertProduct("GALLON_20", "گالن 20 لیتری", "GALLON", "count");

  // 4) Final products (PACK + LITERS)
  const products = ["TP","TC","TN","MN","MC10","MC5","MP11","MP21"];
  for (const p of products) {
    await upsertProduct(`${p}_PACK_5`, `${p} 5L`, "PRODUCT_PACK", "count");
    await upsertProduct(`${p}_PACK_10`, `${p} 10L`, "PRODUCT_PACK", "count");
    await upsertProduct(`${p}_PACK_20`, `${p} 20L`, "PRODUCT_PACK", "count");
    await upsertProduct(`${p}_LITERS`, `${p} (لیتری)`, "PRODUCT_LIQUID", "liter");
  }

  // 5) Formulas (kg per liter) — داده‌های شما
  const formulas = [
    ["TP","P",0.53], ["TP","S",0.304],
    ["TC","C",0.15], ["TC","S",0.27],
    ["TN","C",0.2],  ["TN","S",0.34], ["TN","U",0.4],
    ["MN","C",0.11], ["MN","S",0.18], ["MN","U",0.22],
    ["MC10","C",0.25], ["MC10","S",0.25],
    ["MC5","C",0.115], ["MC5","S",0.196],
    ["MP11","P",0.184], ["MP11","S",0.184],
    ["MP21","P",0.428], ["MP21","S",0.428],
  ];

  for (const [productCode, rawCode, kgPerLiter] of formulas) {
    await prisma.formulaPerLiter.upsert({
      where: { productCode_rawCode: { productCode, rawCode } },
      update: { kgPerLiter },
      create: { productCode, rawCode, kgPerLiter },
    });
  }

  // 6) Alerts rules
  for (const code of ["S","P","U","C","N"]) {
    await prisma.alertRule.upsert({
      where: { warehouseCode_productCode: { warehouseCode: "RAW_WH", productCode: code } },
      update: { minQty: 10000 },
      create: { warehouseCode: "RAW_WH", productCode: code, minQty: 10000 },
    });
  }
  for (const code of ["GALLON_5","GALLON_10","GALLON_20"]) {
    await prisma.alertRule.upsert({
      where: { warehouseCode_productCode: { warehouseCode: "GAL_WH", productCode: code } },
      update: { minQty: 2000 },
      create: { warehouseCode: "GAL_WH", productCode: code, minQty: 2000 },
    });
  }

  // 7) Initial inventory = همان مقدار هشدار
  for (const code of ["S","P","U","C","N"]) await setInv("RAW_WH", code, 10000);
  for (const code of ["GALLON_5","GALLON_10","GALLON_20"]) await setInv("GAL_WH", code, 2000);

  // 8) Users
  await upsertUser("مدیر سیستم", "admin", "admin", "Admin@12345");
  await upsertUser("فروش 1", "sales1", "sales", "Sales@12345");
  await upsertUser("فروش 2", "sales2", "sales", "Sales@12345");
  await upsertUser("انباردار", "warehouse1", "warehouse", "Warehouse@12345");
  await upsertUser("کارشناس تامین 1", "supply1", "supply", "Supply@12345");
  await upsertUser("کارشناس تامین 2", "supply2", "supply", "Supply@12345");

  console.log("✅ Seed completed");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
