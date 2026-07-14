# fabricateSubscriptionClone — Static Fixture Approach

## Background & Motivation

**Vấn đề với approach hiện tại:**
- Mỗi lần test chạy, `fabricateSubscriptionClone` phải query live DB account `2118051` để lấy data
- Nếu account đó bị xóa, thay đổi, hoặc DB không khả dụng → tất cả test fail
- Phụ thuộc vào trạng thái runtime của một account cụ thể

**Approach mới — Static Fixture:**
1. **Một lần duy nhất**: Chạy capture script để dump toàn bộ subscription subtree của account `2118051` ra file JSON (`test-data/provisioning-fixture.json`)
2. **Mỗi lần test**: `fabricateSubscriptionClone` đọc từ JSON đó và INSERT rows vào target account — không cần query DB source nữa

> [!IMPORTANT]
> Account `2118051` (không có prefix `AC-`) là account thật trên sandbox đã được provisioning thành công. File fixture sẽ được commit vào repo và dùng cho tất cả test sau này.

---

## Proposed Changes

---

### PART 1 — Capture Script (chạy 1 lần)

#### [NEW] `scripts/capture-provisioning-fixture.ts`

Script standalone, chạy bằng `ts-node` hoặc `npx tsx`, để dump data account `2118051` ra file JSON.

**Chức năng:**
- Kết nối DB qua `DatabaseHelper`
- Query 4 bảng của account `2118051`
- Ghi ra `test-data/provisioning-fixture.json`
- In summary ra console

**Cách chạy (1 lần, bởi dev):**
```bash
npx tsx scripts/capture-provisioning-fixture.ts
```

---

### PART 2 — Fixture JSON Schema

#### [NEW] `test-data/provisioning-fixture.json`

```jsonc
{
  "capturedAt": "2026-06-30T...",
  "sourceAccountId": "2118051",
  "note": "Snapshot of account 2118051's ACTIVE subscription subtree. Sandbox-only.",
  "subscriptions": [
    { "id": "...", "name": "...", "initialterm": ..., ... }
  ],
  "serviceUnits": [
    { "id": "...", "type": "...", "subscriptionid": "...", "provisioningid": "...", ... }
  ],
  "priceUnits": [
    { "id": "...", "priceofferid": "...", "serviceunitid": "...", "subscriptionid": "...",
      "cyclestart": "...", "cycleend": "...", ... }
  ],
  "priceUnitRatingAttributes": [
    { "id": "...", "currency": "...", "recurringunit": "...", ... }
  ]
}
```

> [!NOTE]
> File này được commit vào repo. Khi cần refresh (account thay đổi trên sandbox), chỉ cần chạy lại capture script và commit lại file.

---

### PART 3 — Refactor `fabricateSubscriptionClone`

#### [MODIFY] [`provisioning.db.ts`](file:///d:/Works/EMBRIX/Automation/EmbrixAuto/helpers/db/provisioning.db.ts)

**Thay đổi signature:**

```typescript
// TRƯỚC
async fabricateSubscriptionClone(
    targetAccountId: string,
    sourceAccountId = 'AC-2118051',   // ← live DB dependency
    idSuffix = '-SIM',
    cycleStartDate?: string,
    logger?: TestLogger
): Promise<void>

// SAU
async fabricateSubscriptionClone(
    targetAccountId: string,
    idSuffix = '-SIM',
    cycleStartDate?: string,
    logger?: TestLogger
): Promise<void>
```

**Logic mới:**
1. Load `test-data/provisioning-fixture.json` bằng `fs.readFileSync` + `JSON.parse`
2. **Pre-check** (giữ nguyên): query target account — phải có `billing_profile`, chưa có `subscription`
3. **INSERT 4 bảng từ fixture rows** (thay vì INSERT...SELECT từ DB):
   - Với mỗi row trong `fixture.subscriptions`: INSERT với `id = row.id + idSuffix`, `accountid = targetAccountId`, `status = 'ACTIVE'`
   - Tương tự cho `serviceUnits`, `priceUnits`, `priceUnitRatingAttributes`
   - `priceUnits`: nếu `cycleStartDate` được truyền, override `cyclestart` / `cycleend` (giữ logic cũ)
4. **Post-check** (giữ nguyên)

**Cách INSERT từ fixture** — dùng parameterized INSERT...VALUES:
```typescript
for (const row of fixture.subscriptions) {
    await this.db.executeQuery(`
        INSERT INTO core_engine.subscription (uuid, id, name, accountid, status, ...)
        VALUES ($1, $1, $2, $3, 'ACTIVE', ...)
    `, [row.id + idSuffix, row.name + idSuffix, targetAccountId, ...]);
}
```

---

## Open Questions

> [!IMPORTANT]
> **Q1**: File `provisioning-fixture.json` có nên đặt trong `test-data/` (cùng với các data file khác) hay tạo thư mục riêng `test-data/fixtures/`?  
> **Assumption hiện tại**: `test-data/provisioning-fixture.json` — đơn giản, nhất quán với pattern hiện tại.

> [!IMPORTANT]
> **Q2**: Capture script (`scripts/capture-provisioning-fixture.ts`) — sau khi chạy xong và file JSON đã commit, script này có cần giữ lại trong repo không (cho lần refresh sau)?  
> **Assumption hiện tại**: Có — giữ lại script để dev có thể chạy lại khi account thay đổi.

> [!IMPORTANT]
> **Q3**: Hiện tại `fabricateSubscriptionClone` nhận `sourceAccountId` như tham số thứ 2. Các test hiện tại có đang gọi hàm này chưa (cần migrate call sites)?  
> **Assumption hiện tại**: Chưa có test nào gọi (hàm mới implement hôm qua) — có thể thay signature mà không cần migrate.

---

## Verification Plan

### Step 1 — Chạy capture script
```bash
npx tsx scripts/capture-provisioning-fixture.ts
```
Verify file JSON được tạo với đủ data (subscription + price_unit > 0).

### Step 2 — Chạy test
Gọi `fabricateSubscriptionClone(targetAccountId)` trong test, verify target account có ACTIVE subscription/price_unit trong DB.
