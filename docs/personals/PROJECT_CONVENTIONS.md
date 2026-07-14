# Quy ước & Hướng dẫn Kiểm thử Tự động hóa Playwright

Tài liệu này phác thảo các tiêu chuẩn mã nguồn, các mẫu thiết kế và quy ước cho **Page Objects**, **Specs (Tests)**, **Fixtures**, và **Helpers** trong dự án **Embrix Auto**. Tất cả các nhà phát triển, kỹ sư QA và trợ lý mã nguồn AI phải tuân thủ các hướng dẫn này khi sửa đổi kho lưu trữ hoặc viết các luồng tự động hóa mới.

---

## 1. Cấu trúc Thư mục

Thư mục dự án được cấu trúc một cách logic. Hãy khớp vị trí của các tệp mới theo đúng phân loại của chúng:

```
EmbrixAuto/
├── docs/                        # Tài liệu dự án (bao gồm tệp này)
├── fixtures/                    # Các Playwright fixtures tùy chỉnh (page-factory.ts)
├── helpers/                     # Các helper API, ghi log, hỗ trợ timeout, hỗ trợ chụp màn hình
│   └── db/                      # Các helper cơ sở dữ liệu bao gói các câu lệnh SQL (ví dụ: JobScheduleDbHelper)
├── pages/                       # Các lớp mô hình Page Object Model (POM)
│   ├── components/              # Các thành phần UI dùng chung (Table, Toast, ReactSelect, Sidebar)
│   ├── customer-hub/            # Thư mục POM con được ánh xạ tới phân hệ Customer Hub
│   └── operations-hub/          # Thư mục POM con được ánh xạ tới phân hệ Operations Hub
└── tests/                       # Các tệp kịch bản kiểm thử (Specs)
    ├── regression/              # Các kịch bản kiểm thử hồi quy (sử dụng trạng thái auth đã lưu)
    └── smoke/                   # Các kiểm thử khói (không phụ thuộc vào auth)
```

---

## 2. Quy ước Đặt tên

*   **Tên tệp (File Names)**: Sử dụng kiểu đặt tên `kebab-case` (chữ thường nối bằng dấu gạch ngang).
    *   Tệp POM: `*.page.ts` (ví dụ: `customer-management.page.ts`)
    *   Tệp Spec: `*.spec.ts` hoặc `*.setup.ts` (ví dụ: `auth.setup.ts`, `ts-01.spec.ts`)
    *   Tệp Helper: `*.helper.ts` (ví dụ: `account-order-api.helper.ts`)
*   **Tên lớp (Class Names)**: Sử dụng kiểu đặt tên `PascalCase`.
    *   POM: `CustomerManagementPage` (bắt buộc phải kết thúc bằng từ `Page`)
    *   Helper: `ServerHelper` (bắt buộc phải kết thúc bằng từ `Helper`)
    *   Component: `TableComponent`, `SidebarComponent` (bắt buộc phải kết thúc bằng từ `Component`)
    *   DB Helper: `JobScheduleDbHelper` (bắt buộc phải kết thúc bằng từ `DbHelper`)
*   **Tên phương thức (Method Names)**: Sử dụng kiểu đặt tên `camelCase` bắt đầu bằng các động từ hành động (ví dụ: `click`, `fill`, `select`, `navigate`, `get`, `verify`).
*   **Bộ định vị / Getters (Locators / Getters)**: Sử dụng kiểu đặt tên `camelCase` khớp với nhãn hiển thị trực quan của phần tử trên màn hình.

---

## 3. Hướng dẫn về Page Object Model (POM)

Tất cả các lớp Page Object phải kế thừa từ lớp cơ sở `BasePage` và bao gói các bộ định vị (selectors) cũng như các thao tác tương tác.

### Kiến trúc & Quy tắc của POM
1.  **Kế thừa từ `BasePage`**: Lớp cơ sở cung cấp các tiện ích dùng chung như `navigate()`, hỗ trợ di chuột (hovers) điều hướng, và kiểm tra hoạt ảnh tải trang.
2.  **Bộ định vị dạng Private Getters**: Không công khai các bộ định vị thô hoặc bộ định vị của Playwright dưới dạng các biến public. Hãy định nghĩa chúng dưới dạng thuộc tính `private get`. Việc này trì hoãn việc đánh giá định vị (lazy evaluation) và tăng tính đóng gói.
3.  **Khẳng định (Assertions)**: Giữ các câu lệnh khẳng định (assertions/expects) nằm ngoài các phương thức hành động trong POM. Hãy viết các khẳng định trực tiếp ở tệp Spec, hoặc tạo các phương thức xác minh chuyên biệt trong POM được bắt đầu bằng tiền tố `verify*` hoặc `assert*`.
4.  **Sử dụng Component dùng chung**: Không lặp lại bộ định vị cho các tiện ích UI tiêu chuẩn. Hãy sử dụng các component có sẵn như `TableComponent`, `ToastComponent`, `ReactSelectComponent`, và `SidebarComponent`.
5.  **Quản lý Trạng thái Tải trang**: Gọi lệnh `await this.page.waitForLoadingToDisappear();` sau các hành động kích hoạt API backend hoặc kích hoạt sự kiện tải trang.

### Ví dụ Code mẫu POM
```typescript
import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from '../../base.page';
import { SHORT_WAIT, MEDIUM_WAIT } from '../../../helpers/timeouts.helper';
import { TableComponent } from '../../components/table.component';

/**
 * FeatureNamePage — Đại diện cho màn hình Feature Name trong ứng dụng.
 */
export class FeatureNamePage extends BasePage {
  readonly mainTable: TableComponent;

  constructor(page: Page) {
    super(page);
    this.mainTable = new TableComponent(page, this.page.locator('table').first());
  }

  // ── DOM Elements ────────────────────────────────────────────────────────

  private get searchInput() { return this.page.locator('input[name="search"]') }
  private get submitButton() { return this.page.getByRole('button', { name: 'Submit' }) }

  // ── Public Action Methods ────────────────────────────────────────────────

  async searchItem(keyword: string): Promise<void> {
    await this.searchInput.waitFor({ state: 'visible', timeout: MEDIUM_WAIT });
    await this.searchInput.fill(keyword);
    await this.submitButton.click();
    await this.page.waitForLoadingToDisappear();
  }
}
```

---

## 4. Quy ước đối với tệp Spec (Kiểm thử)

Các tệp Spec chứa các kịch bản kiểm thử và các câu lệnh khẳng định kết quả.

### Quy tắc viết Spec
1.  **Import từ Page-Factory**: Luôn import đối tượng `test` và `expect` từ tệp cấu hình page-factory nội bộ của dự án, **không bao giờ** import trực tiếp từ thư viện `@playwright/test`.
    *   *Đúng*: `import { test, expect } from '../../../fixtures/page-factory';`
    *   *Sai*: `import { test, expect } from '@playwright/test';`
2.  **Chạy tuần tự (Serial Execution)**: Sử dụng kịch bản chạy tuần tự `test.describe.serial` cho các bài kiểm thử hồi quy dạng chuỗi quy trình (workflow-based), nơi các ca kiểm thử phía sau phụ thuộc vào dữ liệu được tạo ra bởi các ca kiểm thử phía trước.
3.  **Quản lý Trạng thái Suite**: Định nghĩa một interface `SuiteState` cục bộ và một đối tượng trạng thái thay đổi (`const state: Partial<SuiteState> = {}`) để chia sẻ các giá trị giữa các bài test chạy tuần tự.
4.  **Bảo toàn Trạng thái E2E**: Sử dụng hàm `updateTestContext()` để lưu các mã định danh quan trọng được tạo ra (ví dụ: `accountId`, `orderId`) vào hệ thống tệp tin (`playwright/.auth/test-context.json`). **Không bao giờ** gọi hàm `saveTestContext()` từ giữa mã nguồn suite — việc này sẽ ghi đè toàn bộ tệp và xóa sạch dữ liệu từ các kiểm thử trước đó. Hãy luôn sử dụng `updateTestContext()` để thực hiện gộp/merge dữ liệu từng phần.
5.  **Ghi Log**: Sử dụng fixture `testLogger` để ghi log cho các hành động, dữ liệu gọi API và phản hồi thay vì sử dụng câu lệnh `console.log` mặc định.

### Ví dụ Code mẫu Spec
```typescript
import { test, expect } from '../../../fixtures/page-factory';
import { updateTestContext } from '../../../helpers/test-context.helper';

interface SuiteState {
  accountId: string;
}

const state: Partial<SuiteState> = {};

test.describe.serial('REGRESSION: Quy trình Xử lý Đơn hàng', () => {

  test('TC-01: Tạo tài khoản cư dân', async ({
    page, accountOrderApiHelper, testLogger, customerManagementPage
  }) => {
    const { accountId } = await accountOrderApiHelper.createAccountAndOrder();
    state.accountId = accountId;
    testLogger.data('Mã tài khoản đã tạo', accountId);

    await page.navigateToHome();
    await customerManagementPage.navigateViaNav();
    await customerManagementPage.searchByAccountId(accountId);

    const activeAcct = await customerManagementPage.getFirstRowCellValue('ACCT No');
    expect(activeAcct).toBe(accountId);

    updateTestContext({ accountId });
  });
});
```

---

## 5. Quy ước đối với Fixtures

Fixtures quản lý cơ chế Dependency Injection (DI - tiêm phụ thuộc) và tự động khởi tạo các đối tượng Page Object / Helper.

1.  **Centralized Factory Registry (Nhà máy đăng ký tập trung)**: Quản lý và đăng ký tất cả các fixtures kiểm thử tập trung tại một tệp duy nhất [page-factory.ts](../../fixtures/page-factory.ts). Tránh việc chia nhỏ nhiều file fixture riêng lẻ gây chồng chéo import và phân mảnh mã nguồn.
2.  **Mở rộng Context**: Sử dụng cơ chế mở rộng `base.extend<AllFixtures>({ ... })` để toàn bộ các Page Object và Helper được tiêm phụ thuộc dùng chung một đối tượng page/request context duy nhất.
3.  **Tích hợp trực tiếp hàm tiện ích vào Page (Monkey Patching)**: Định nghĩa các trình tiện ích có sẵn toàn cục bằng cách mở rộng trực tiếp giao diện `Page` gốc của Playwright trong tệp factory (ví dụ: định nghĩa `page.navigateToHome()` và `page.waitForLoadingToDisappear()`). Cách tiếp cận này giúp các component và Page Objects có thể gọi các tiện ích tải trang một cách tự nhiên mà không cần kế thừa chặt chẽ hay trùng lặp mã nguồn.
4.  **Fixture quản lý Trạng thái / Context**: Sử dụng fixture `testContext` (cung cấp các phương thức `load()`, `update()`, và `save()`) để quản lý việc lưu và đọc trạng thái chia sẻ giữa các bài test một cách trơn tru, không cần đọc tệp thủ công trong kịch bản spec.

---

## 6. Luồng kiến trúc điều phối dữ liệu (DI Flow)

Mô hình kiểm thử tự động hóa trong dự án hoạt động theo một luồng phân tách trách nhiệm chặt chẽ:

```
[Spec File (*.spec.ts)]
         │
         ▼ (Yêu cầu fixture qua parameters)
[Centralized Fixture (page-factory.ts)]
         │
         ├──► (Khởi tạo POM với Page context) ──► [Page Object (*.page.ts)] ──► Thao tác UI
         └──► (Khởi tạo Helper với Request)   ──► [Helper (*.helper.ts)]     ──► Gọi API / DB
```

*   **Spec**: Chỉ quản lý kịch bản kiểm thử cao cấp và các điểm kiểm tra khẳng định kết quả (`expect`).
*   **Fixture**: Điều phối và giải quyết các phụ thuộc, tiêm các Page Objects và Helper sẵn sàng vào Spec.
*   **Page Object (POM)**: Quản lý bộ chọn giao diện và cung cấp các hàm tương tác nghiệp vụ trên màn hình.
*   **Helper**: Cung cấp các thao tác không liên quan đến UI (như gọi REST/GraphQL API, truy vấn trực tiếp DB) để phục vụ thiết lập môi trường chạy test nhanh chóng.

---

## 7. Quy ước về Timeouts tiêu chuẩn & Tránh Flakiness

1.  **Tuyệt đối không sử dụng thời gian chờ cứng (No Hardcoded/Fixed Waits)**:
    *   Tránh sử dụng `page.waitForTimeout()` một cách bừa bãi. Thay vào đó, hãy luôn chờ đợi một cách động (dynamically) dựa trên trạng thái của phần tử giao tiếp (ví dụ: sử dụng `.waitFor({ state: 'visible' | 'hidden' })` hoặc `page.waitForURL()`).
    *   **Quy tắc đối với AI**: Nếu trong quá trình phát triển không thể xác định phần tử tiếp theo cần đợi, hoặc không chắc chắn việc chờ đợi có cần thiết hay không, **bạn phải dừng lại và hỏi nhà phát triển/người dùng** để làm rõ thay vì tự ý thêm các lệnh chờ cứng.
2.  **Sử dụng cơ chế Catch Lỗi Mềm cho Hoạt ảnh Tải trang**:
    *   Khi viết các lệnh chờ hoạt ảnh spinner biến mất (ví dụ trong `waitForLoadingToDisappear`), bắt buộc phải gắn thêm khối xử lý lỗi rỗng `.catch(() => {})` cho cả lệnh chờ hiển thị và ẩn đi. Điều này ngăn chặn việc kiểm thử bị lỗi timeout đột ngột (crash test) trên những màn hình tải quá nhanh mà spinner chưa kịp render hoặc không xuất hiện.
3.  **Sử dụng Hằng số Timeouts Tiêu chuẩn**:
    Hãy sử dụng các hằng số được định nghĩa sẵn và import từ `timeouts.helper.ts` thay vì viết trực tiếp giá trị mili-giây:
    *   `SHORT_WAIT`: 1 giây - 3 giây (chờ độ ổn định phần tử, hiệu ứng chuyển động nhỏ)
    *   `MEDIUM_WAIT`: 5 giây - 10 giây (chờ các truy vấn định vị tiêu chuẩn, tải kết quả tìm kiếm)
    *   `LONG_WAIT`: 10 giây - 20 giây (chờ chuyển hướng trang API, mở modal lớn)
    *   `EXTRA_LONG_WAIT`: 30 giây - 60 giây (chờ xử lý các jobs ngầm nặng, đồng bộ trạng thái provisioning)

---

## 8. Quy ước đối với Helper Cơ sở dữ liệu

Để duy trì tính sạch sẽ của mô hình Page Object Model (POM) và sự phân tách rõ ràng về mặt kiến trúc:

1.  **Phân tách trách nhiệm**: Không bao giờ thực thi trực tiếp các câu lệnh SQL bên trong các lớp Page Object hoặc các tệp Spec. Tất cả các hoạt động tương tác với cơ sở dữ liệu phải được bao gói hoàn toàn vào các helper DB chuyên biệt (ví dụ: `helpers/db/job-schedule.db.ts`, `helpers/db/provisioning.db.ts`).
2.  **Helper chung so với Helper nghiệp vụ**:
    *   `helpers/database.helper.ts` là client kết nối PostgreSQL chung. Không thêm các câu lệnh truy vấn nghiệp vụ cụ thể tại đây.
    *   Các lớp helper nghiệp vụ riêng lẻ (như `JobScheduleDbHelper`) sẽ import `DatabaseHelper` và bao gói các câu truy vấn SQL tương ứng.
3.  **Bao gói Câu lệnh SQL**: Lưu trữ các câu lệnh SQL dưới dạng chuỗi viết hoa rõ ràng hoặc biểu thức nội suy tham số ở đầu phương thức helper để tách biệt logic cơ sở dữ liệu với logic thực thi Javascript.
4.  **Thời gian chờ thực thi (Statement Timeout)**: Luôn định cấu hình `statement_timeout` trên PG client (sử dụng giá trị `EXTRA_LONG_WAIT` từ `timeouts.helper.ts`) để tránh việc kịch bản kiểm thử bị treo vô hạn do các truy vấn chậm hoặc sự cố kết nối mạng.

---

## 9. Quy ước đối với Sidebar Component

Lớp `SidebarComponent` (`pages/components/sidebar.component.ts`) là một thành phần điều hướng thanh bên trái có thể tái sử dụng trên toàn bộ các phân hệ của ứng dụng (Account Details, Jobs Management, v.v.).

### Quy tắc sử dụng
1.  **Sử dụng SidebarComponent cho các trang mới**: Bất kỳ màn hình mới nào có cấu trúc điều hướng thanh bên trái bắt buộc phải soạn thảo và tích hợp lớp `SidebarComponent` làm thuộc tính thành viên, không tự viết lại logic click thanh bên.
2.  **Hỗ trợ đa cấp**: Phương thức `sidebar.navigateTo('Category', 'Level2')` hoặc `sidebar.navigateTo('Category', 'Level2', 'Level3')` hỗ trợ điều hướng sâu từ 2 đến 3 cấp mục.
3.  **Dùng trạng thái hiển thị thực tế làm chân lý**: Thành phần này tự động kiểm tra xem mục menu con mục tiêu đã hiển thị trên màn hình hay chưa trước khi thực hiện click, giúp tránh các thao tác đóng-mở menu thừa không cần thiết. Nó hoàn toàn không phụ thuộc vào các thuộc tính hay class CSS có thể bị trễ trong các ứng dụng SPA (như `aria-expanded` hay `display-none`).

---

*Tài liệu được cập nhật lần cuối: 13-06-2026 | Phiên bản 4.2 | Dự án: EmbrixAuto*
