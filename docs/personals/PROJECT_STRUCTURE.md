# 📁 Cấu trúc Thư mục Dự án — EmbrixAuto

> **Dự án**: Kiểm thử tự động nền tảng Embrix O2X
> **Công nghệ**: Playwright + TypeScript
> **Mục tiêu**: Tự động hóa kiểm thử UI, API và E2E cho toàn bộ quy trình nghiệp vụ Order-to-Cash
> **Cập nhật lần cuối**: 13-06-2026 | Phiên bản: 4.2

---

## 🗂️ Sơ đồ cấu trúc tổng quan

```
EmbrixAuto/
│
├── 📄 playwright.config.ts              ← Cấu hình trung tâm Playwright
├── 📄 package.json                      ← Các thư viện phụ thuộc & câu lệnh viết tắt npm
├── 📄 tsconfig.json                     ← Cấu hình biên dịch TypeScript
├── 📄 .env.example                      ← Tệp tin cấu hình môi trường mẫu (sao chép → .env)
├── 📄 .gitignore                        ← Liệt kê các tệp/thư mục Git bỏ qua
├── 📄 .gitlab-ci.yml                    ← Cấu hình pipeline chạy CI/CD trên GitLab
├── 📄 README.md                         ← Mô tả sơ lược về dự án
│
├── 📁 docs/                             ← Tài liệu hướng dẫn dự án
│   ├── 📄 PROJECT_GUIDE.md              ← Hướng dẫn bắt đầu nhanh và chạy test
│   ├── 📄 PROJECT_CONVENTIONS.md        ← Quy ước lập trình và chuẩn thiết kế
│   ├── 📄 PROJECT_STRUCTURE.md          ← Tài liệu này - chi tiết cấu trúc thư mục
│   └── 📁 vi/                           ← Bản dịch tài liệu tiếng Việt (đã được gitignore)
│
├── 📁 fixtures/                         ← Thư mục Fixtures của Playwright (Dependency Injection)
│   └── 📄 page-factory.ts              ← ★ Fixture trung tâm - tích hợp tất cả POMs, Helpers vào 1 test context
│
├── 📁 pages/                            ← Mô hình Page Object Model (POM)
│   ├── 📄 base.page.ts                 ← Lớp cơ sở trừu tượng - cung cấp tiện ích chuyển trang, hoạt ảnh tải
│   ├── 📄 login.page.ts                ← LoginPage - xử lý đăng nhập vào giao diện Embrix
│   ├── 📁 components/                   ← Các component giao diện dùng chung (không kế thừa BasePage)
│   │   ├── 📄 toast.component.ts        ← ToastComponent - kiểm tra các thông báo Toastify hiển thị
│   │   ├── 📄 react-select.component.ts ← ReactSelectComponent - tương tác với thanh chọn dạng react-select
│   │   ├── 📄 table.component.ts        ← TableComponent - đọc dữ liệu, tìm dòng và tương tác với bảng UI
│   │   └── 📄 sidebar.component.ts      ← SidebarComponent - thanh bên trái điều hướng chung
│   ├── 📁 customer-hub/                 ← Phân hệ Customer Hub
│   │   ├── 📁 customer-management/
│   │   │   ├── 📄 customer-management.page.ts   ← Tìm kiếm tài khoản, xem danh sách
│   │   │   └── 📁 account-details/
│   │   │       ├── 📄 account-details-sidebar.ts        ← Wrapper thanh bên trái cho Account Details
│   │   │       ├── 📁 account-data/
│   │   │       │   └── 📄 account-info.page.ts          ← Customer Activity, xem chi tiết modal
│   │   │       ├── 📁 billing-data/
│   │   │       │   └── 📄 bills.page.ts                 ← Bảng quản lý hóa đơn Open/Closed Bills
│   │   │       └── 📁 subscription-data/
│   │   │           └── 📄 services.page.ts              ← Bảng theo dõi dịch vụ và đơn hàng dở dang
│   │   └── 📁 order-management/
│   │           └── 📄 order-management.page.ts      ← Tạo đơn hàng mới, luồng nghiệp vụ cấp dịch vụ
│   └── 📁 operations-hub/              ← Phân hệ Operations Hub
│       └── 📁 jobs-management/
│           └── 📄 daily-schedule.page.ts         ← Màn hình chạy jobs hàng ngày (Daily Schedule)
│
├── 📁 helpers/                          ← Các tệp tiện ích & Trình xử lý API backend
│   ├── 📁 db/                           ← Trình tương tác DB (bao gói các câu truy vấn SQL)
│   │   ├── 📄 job-schedule.db.ts        ← Hỗ trợ truy vấn và dọn dẹp lịch trình jobs trong DB
│   │   └── 📄 provisioning.db.ts        ← Hỗ trợ bypass provisioning (bỏ qua cấp dịch vụ) qua database và GraphQL
│   ├── 📄 database.helper.ts           ← Trình kết nối PostgreSQL chung (Pool, statement timeout, retry)
│   ├── 📄 screenshot.helper.ts         ← Hỗ trợ chụp ảnh màn hình và đính kèm vào báo cáo HTML
│   ├── 📄 account-order-api.helper.ts   ← Hỗ trợ gọi REST API: tạo tài khoản khách hàng, thanh toán hóa đơn
│   ├── 📄 daily-schedule-flow.helper.ts ← Hỗ trợ điều phối chuỗi chạy jobs hàng ngày
│   ├── 📄 test-context.helper.ts        ← Quản lý tệp test-context.json chia sẻ trạng thái E2E
│   ├── 📄 server-api.helper.ts          ← Hỗ trợ gọi GraphQL API: lấy và thiết lập ngày hệ thống (CCP Time)
│   ├── 📄 test-logger.ts               ← Trình ghi log có cấu trúc (LOG/DATA/API/ERROR) ra tệp tin
│   └── 📄 timeouts.helper.ts           ← Hằng số timeouts tiêu chuẩn (SHORT → EXTRA_LONG)
│
├── 📁 tests/                            ← Nơi chứa toàn bộ kịch bản kiểm thử (Specs)
│   ├── 📄 auth.setup.ts                ← Setup: chạy một lần đầu tiên để đăng nhập và lưu session cookie
│   ├── 📁 smoke/
│   │   └── 📄 health-check.spec.ts      ← Kiểm thử khói: kiểm tra form đăng nhập, SEO, thông báo lỗi
│   └── 📁 regression/
│       └── 📁 coopeguanacaste/          ← Kiểm thử hồi quy cho khách hàng Coopeguanacaste
│           ├── 📄 read-context.spec.ts  ← Tệp kịch bản mẫu hướng dẫn thao tác với test context
│           ├── 📄 ts-01.spec.ts         ← Kịch bản TS-01: Tạo tài khoản → Hóa đơn → Cấp dịch vụ (bypass qua DB) → Chạy Jobs
│           └── 📄 leagcy.spec.ts        ← Kịch bản kiểm thử luồng cấp dịch vụ thông thường (normal provisioning), trước khi áp dụng bypass qua DB
│
├── 📁 test-data/                        ← Quản lý dữ liệu kiểm thử (đầu vào dạng JSON)
│   ├── 📄 accounts.data.json           ← Thông tin mặc định tạo tài khoản (RESIDENTIAL_DEFAULT)
│   ├── 📄 services.data.json           ← Cấu hình danh mục dịch vụ (gói Internet 100Mbps)
│   └── 📄 provisioning.data.json       ← Dữ liệu cấp phép thiết bị (ontModel, provisioningId)
│
├── 📁 playwright/                       ← Dữ liệu nội bộ sinh ra bởi Playwright
│   └── 📁 .auth/                       ← Thư mục lưu session và dữ liệu chạy suite (Không commit lên Git)
│       ├── 📄 user.json                ← Lưu trạng thái lưu trữ session cookie sau khi auth.setup.ts chạy
│       └── 📄 test-context.json        ← Lưu trữ thông tin chia sẻ giữa các ca kiểm thử (accountId, orderId...)
│
├── 📁 playwright-report/               ← Thư mục chứa báo cáo HTML (được tự động sinh ra sau khi chạy)
│   └── 📁 test-results/                 ← Các tệp ảnh chụp, video quay màn hình khi test lỗi
│       └── 📁 logs/                     ← Các tệp ghi log chi tiết sinh ra từ TestLogger
```

---

## 📄 Mô tả chi tiết các tệp tin cốt lõi

### ⚙️ `playwright.config.ts`

**Mục đích**: Tệp tin cấu hình trung tâm cho toàn bộ quá trình thực thi của Playwright.

| Thuộc tính        | Giá trị thực tế           | Ý nghĩa nghiệp vụ                               |
| ----------------- | ------------------------- | ----------------------------------------------- |
| `testDir`         | `./tests`                 | Thư mục gốc chứa các kịch bản kiểm thử          |
| `fullyParallel`   | `false`                   | Chạy tuần tự (do các ca kiểm thử phụ thuộc nhau)|
| `timeout`         | `600_000` (10 phút)       | Thời gian chạy tối đa cho mỗi ca kiểm thử (E2E) |
| `retries`         | `2` (CI), `0` (local)     | Số lần chạy lại nếu phát hiện lỗi               |
| `workers`         | `1`                       | Số luồng thực thi song song (tránh xung đột dữ liệu)|

**3 Dự án (Projects - Bộ kịch bản)**:

| Dự án (Project)   | `testMatch`                                 | Ý nghĩa nghiệp vụ                         | Phụ thuộc |
| ----------------- | ------------------------------------------- | ----------------------------------------- | --------- |
| `setup`           | `**/auth.setup.ts`                          | Đăng nhập và lưu session cookie một lần   | —         |
| `smoke`           | `**/smoke/*.spec.ts`                        | Chạy kiểm thử khói để kiểm tra nhanh      | —         |
| `regression`      | `**/regression/coopeguanacaste/*.spec.ts`   | Chạy toàn bộ chuỗi kịch bản hồi quy E2E   | `setup`   |

---

### 📄 `package.json`

**Mục đích**: Khai báo các thư viện phụ thuộc và cung cấp các câu lệnh phím tắt để chạy kiểm thử.

**Các câu lệnh chạy chính**:
*   `npm test`: Chạy toàn bộ các bài test ở chế độ ẩn (headless).
*   `npm run test:headed`: Chạy tất cả các bài test ở chế độ có hiển thị trình duyệt.
*   `npm run test:ui`: Khởi chạy giao diện UI Mode trực quan của Playwright.
*   `npm run test:setup`: Chỉ chạy bước đăng nhập hệ thống để chuẩn bị session.
*   `npm run test:smoke`: Chỉ thực thi bộ kiểm thử khói (smoke tests).
*   `npm run test:regression`: Chỉ thực thi bộ kiểm thử hồi quy (regression suite).
*   `npm run report`: Xem báo cáo kết quả HTML vừa tạo.

---

### 📄 `.env.example`

Tệp cấu hình mẫu cho các thông số môi trường nhạy cảm. Nhà phát triển cần tạo tệp `.env` riêng cục bộ và điền đầy đủ:
*   `TEST_ENV`: Môi trường kiểm thử (`sandbox`).
*   `EMBRIX_USER`: Tài khoản đăng nhập giao diện UI.
*   `EMBRIX_PASSWORD`: Mật khẩu đăng nhập giao diện UI.
*   `EMBRIX_API_BEARER_TOKEN`: JWT Token để xác thực gọi API CRM Gateway.

---

## 📁 Thư mục `fixtures/` — Dependency Injection

### 📄 `fixtures/page-factory.ts` ★ Fixture Trung tâm

**Mục đích**: Đăng ký và quản lý tập trung toàn bộ các Page Object, Trình tiện ích, Logger và Helper trong cùng một tệp. Cơ chế tiêm phụ thuộc `base.extend<AllFixtures>()` giúp các lớp nghiệp vụ chia sẻ chung tài nguyên một cách an toàn.

**Các Fixtures được tiêm vào**:

| Fixture                    | Kiểu dữ liệu                                    | Vai trò nhiệm vụ                                     |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `page`                     | `Page` (mở rộng)                                | Playwright Page + tích hợp sẵn tiện ích tải trang    |
| `testLogger`               | `TestLogger`                                    | Ghi log có cấu trúc, tự động đính kèm vào HTML report|
| `loginPage`                | `LoginPage`                                     | Page Object cho màn hình đăng nhập                   |
| `customerManagementPage`   | `CustomerManagementPage`                        | Page Object cho màn hình quản lý tài khoản           |
| `billsPage`                | `BillsPage`                                     | Page Object cho phân hệ quản lý Hóa đơn              |
| `orderManagementPage`      | `OrderManagementPage`                           | Page Object cho phân hệ tạo Đơn hàng và Cấp dịch vụ  |
| `accountInfoPage`          | `AccountInfoPage`                               | Page Object cho màn hình xem thông tin chi tiết và Activity|
| `sidebar`                  | `SidebarComponent`                              | Component thanh điều hướng bên trái dùng chung       |
| `servicesPage`             | `ServicesPage`                                  | Page Object quản lý dịch vụ khách hàng               |
| `serverHelper`             | `ServerHelper`                                  | Helper gọi API GraphQL để thiết lập ngày máy chủ    |
| `accountOrderApiHelper`    | `AccountOrderApiHelper`                         | Helper gọi REST API tạo tài khoản & thanh toán nhanh |
| `jobScheduleDbHelper`      | `JobScheduleDbHelper`                           | Trình tương tác DB dọn dẹp dữ liệu lịch trình jobs   |
| `provisioningDbHelper`     | `ProvisioningDbHelper`                          | Trình tương tác DB và GraphQL để bypass quá trình cấp dịch vụ |
| `toast`                    | `ToastComponent`                                | Component bắt các thông báo Toastify thành công/lỗi  |
| `reactSelect`              | Factory tạo `ReactSelectComponent`              | Khởi tạo thanh chọn react-select trong vùng locator  |
| `table`                    | Factory tạo `TableComponent`                    | Khởi tạo bảng dữ liệu nghiệp vụ trong vùng locator   |
| `testContext`              | Tiện ích đọc/ghi                                | Hỗ trợ đọc, gộp và cập nhật dữ liệu test-context.json|
| `rerunDailyScheduleFlow`   | Hàm tiện ích chạy workflow                      | Điều phối việc chạy các jobs hàng ngày qua DB & UI   |

> **Lưu ý**: Dự án đã loại bỏ hoàn toàn các tệp fixture riêng lẻ cũ (như `api-fixtures/` và `pages-fixtures/`) để tránh mã nguồn chết. Tất cả được khai báo và bảo trì tập trung trong tệp duy nhất [page-factory.ts](../../fixtures/page-factory.ts).

---

## 📁 Thư mục `pages/` — Page Object Model

### 🏗️ Kiến trúc POM của dự án

```
BasePage (Lớp cơ sở trừu tượng)
    ↑ được kế thừa bởi
├── LoginPage
├── SearchAccountsPage
├── AccountInfoPage
├── BillsPage
├── ServicesPage
├── OrderManagementPage
└── DailySchedulePage

Các thành phần giao diện độc lập (Không kế thừa BasePage):
├── ToastComponent
├── ReactSelectComponent
├── TableComponent
└── SidebarComponent
```

*   **`pages/base.page.ts`**: Lớp cơ sở trừu tượng chứa các hoạt động chung của toàn bộ trang web (như hỗ trợ di chuột điều hướng, chuyển đổi trang, dọn dẹp các dropdowns mở).
*   **`pages/components/`**: Các thành phần UI có thể tái sử dụng nhiều nơi (ví dụ: `TableComponent` hỗ trợ đọc nội dung bảng tốc độ cao qua `allTextContents()` chỉ với 1 kết nối CDP; `SidebarComponent` hỗ trợ điều hướng thanh bên 2-3 cấp dựa trên trạng thái hiển thị thực tế của phần tử).

---

## 📁 Thư mục `helpers/` — Trình hỗ trợ API và Nghiệp vụ

*   **`helpers/db/job-schedule.db.ts`**: Nơi lưu trữ các truy vấn cơ sở dữ liệu để tìm kiếm, dọn dẹp và cập nhật trạng thái các jobs cước, giúp Spec thiết lập môi trường sạch trước khi chạy test.
*   **`helpers/db/provisioning.db.ts`**: Helper tương tác DB và GraphQL để bypass quá trình Nokia provisioning (cấp dịch vụ mạng).
*   **`helpers/database.helper.ts`**: Client kết nối cơ sở dữ liệu PostgreSQL dùng chung (quản lý kết nối qua Pool, xử lý SSL và statement timeout an toàn).
*   **`helpers/account-order-api.helper.ts`**: Gọi API CRM Gateway để thực hiện nhanh quy trình thiết lập tài khoản cư dân và thanh toán hóa đơn lắp đặt đầu tiên.
*   **`helpers/server-api.helper.ts`**: Trình tương tác với server GraphQL để thay đổi thời gian hệ thống CCP Time.
*   **`helpers/test-logger.ts`**: Ghi lại log hoạt động nghiệp vụ chi tiết và tự động đính kèm vào báo cáo HTML khi hoàn thành kịch bản.

---

## 📁 Thư mục `tests/` — Kịch bản kiểm thử

*   **`tests/auth.setup.ts`**: Chạy một lần duy nhất trước bộ kiểm thử hồi quy để lưu thông tin đăng nhập thành công vào `playwright/.auth/user.json`.
*   **`tests/smoke/health-check.spec.ts`**: Kịch bản kiểm thử khói để xác minh ứng dụng hoạt động bình thường trên môi trường pipeline CI.
*   **`tests/regression/coopeguanacaste/ts-01.spec.ts`**: Chuỗi kịch bản kiểm thử E2E đầy đủ quy trình nghiệp vụ từ lúc tạo tài khoản, trả hóa đơn đầu tiên, cài đặt thiết bị, chạy jobs chu kỳ cước Grace Period và cước định kỳ (đang áp dụng cơ chế bypass provisioning qua DB/GraphQL).
*   **`tests/regression/coopeguanacaste/leagcy.spec.ts`**: Kịch bản kiểm thử luồng cấp dịch vụ thông thường qua UI (normal provisioning process) được bảo tồn trước khi chuyển sang cơ chế bypass qua DB.

---

*Tài liệu được cập nhật lần cuối: 13-06-2026 | Phiên bản 4.2 | Dự án: EmbrixAuto*
