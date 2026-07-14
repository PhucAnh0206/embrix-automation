# Bối cảnh & Bộ nhớ Dự án (Project Context & Memory)

Tài liệu này đóng vai trò như một điểm kiểm soát bộ nhớ cho các AI agent và các nhà phát triển. Nó ghi lại trạng thái hiện tại, tiến độ, cập nhật cấu trúc và những phát hiện quan trọng của dự án **Embrix Auto**. Hãy cập nhật tệp này vào cuối mỗi phiên làm việc.

---

## 1. Tổng quan dự án

*   **Ứng dụng**: Embrix CoreUI Automation
*   **Công nghệ**: Playwright, TypeScript, Node.js, PostgreSQL (thư viện `pg`).
*   **Kiến trúc**: Page Object Model (POM) kết hợp với một tệp fixture trung tâm (`fixtures/page-factory.ts`), các component giao diện tái sử dụng (`pages/components/`), các trình hỗ trợ cơ sở dữ liệu (`helpers/db/`), và các helper điều phối API backend (`helpers/`).
*   **Môi trường**: Sandbox (`TEST_ENV=sandbox`). Sử dụng endpoint GraphQL ở backend để thiết lập thời gian hệ thống (CCP Time), CRM Gateway REST API để tạo tài khoản kiểm thử/thanh toán hóa đơn, và cơ sở dữ liệu PostgreSQL (AWS RDS) để xác minh và dọn dẹp dữ liệu trực tiếp.

---

## 2. Trạng thái hiện tại của dự án

### Các phần đã hoàn thành & hoạt động tốt:
*   **Thiết lập Auth (`auth.setup.ts`)**: Đăng nhập thành công và lưu trạng thái session cookies/localStorage vào `playwright/.auth/user.json`.
*   **Tài liệu Quy ước**: Tài liệu hướng dẫn thống nhất được duy trì tại `PROJECT_CONVENTIONS.md` (tiếng Anh) và `docs/personals/PROJECT_CONVENTIONS.md` (tiếng Việt).
*   **Component Tái sử dụng**: `ToastComponent`, `ReactSelectComponent`, `TableComponent`, `SidebarComponent` — tất cả nằm trong `pages/components/`.
*   **Tích hợp Cơ sở dữ liệu**: Trình quản lý kết nối chung `DatabaseHelper` sử dụng `pg.Pool` (hỗ trợ SSL, giới hạn thời gian thực thi statement, cơ chế thử lại/truy vấn tuần tự) + các helper theo nghiệp vụ trong `helpers/db/` (ví dụ: `JobScheduleDbHelper`, `ProvisioningDbHelper`).
*   **Bộ kiểm thử Suite 01 Chính thức (`ts-01.spec.ts`)**: Chạy tuần tự dưới chỉ thị `test.describe.serial`. Kịch bản này áp dụng cơ chế bypass provisioning qua DB/GraphQL (`bypassProvisioning` qua `ProvisioningDbHelper`):
    *   **TC-00**: Thiết lập ngày hệ thống trên máy chủ thông qua GraphQL (tạo ngày ngẫu nhiên để mô phỏng chu kỳ cước).
    *   **TC-01**: Tạo tài khoản cư dân và đơn hàng thông qua REST API, xác minh thông tin hiển thị trên UI.
    *   **TC-02**: Bỏ qua quá trình cấp dịch vụ (bypass provisioning) bằng cách cập nhật cơ sở dữ liệu và gọi GraphQL, kiểm tra đơn hàng hoàn thành.
    *   **TC-03**: Chạy các billing jobs cho Recurring Billing Month 01 và xác minh hóa đơn định kỳ.
    *   **TC-04**: Chạy các billing jobs cho Recurring Billing Month 02 và xác minh hóa đơn định kỳ tiếp theo.
*   **Bộ kiểm thử Legacy/Normal Provisioning (`leagcy.spec.ts`)**: Tệp kịch bản E2E mẫu đại diện cho luồng kiểm thử cấp dịch vụ thông thường qua UI (normal provisioning process) và đợi SMS Nokia Callback (FINALIZADO), được bảo tồn trước khi chuyển sang cơ chế bypass qua DB:
    *   **TC-00**: Thiết lập ngày hệ thống CCP Time.
    *   **TC-01**: Tạo tài khoản cư dân và đơn hàng.
    *   **TC-03**: Cấp dịch vụ thông qua UI (nhập serial, ont model) và truy vấn Customer Activity để xác minh status Nokia đạt `FINALIZADO`.
    *   **TC-05**: Recurring Billing Month 01.
    *   **TC-06**: Recurring Billing Month 02.
    *   **TC-07**: Collection Notification Month 02 (xác minh chuyển trạng thái nợ COLLECTION và kiểm thử suspend).
*   **Spec tham chiếu Context (`read-context.spec.ts`)**: Spec mẫu hướng dẫn cách đọc, ghi và cập nhật trạng thái chia sẻ `SavedContext` một cách an toàn thông qua helper hoặc fixture `testContext`.

---

## 3. Các quyết định kỹ thuật quan trọng & Sửa lỗi

*   **Tập trung hóa Fixtures & Dọn dẹp Code**:
    *   *Quyết định*: Xóa bỏ 10 tệp fixture riêng lẻ cũ (trong `api-fixtures/` và `pages-fixtures/`) và các tệp fixture thành phần rời rạc. Gom tất cả các khai báo fixture, khởi tạo Page/Helper và mở rộng context vào một tệp duy nhất [page-factory.ts](../../fixtures/page-factory.ts). Việc này giúp giảm 30% số tệp dư thừa, cải thiện cấu trúc import và loại bỏ hoàn toàn mã nguồn chết (dead code).
*   **Khắc phục lỗi Dual-Write trong TestLogger**:
    *   *Sự cố*: `TestLogger` vừa lưu bộ đệm (buffer) rồi ghi file hàng loạt khi gọi `flush()`, vừa ghi trực tiếp bằng `appendFileSync` trong hàm `write()`. Điều này khiến file log bị ghi lặp lại nội dung giống nhau.
    *   *Giải pháp*: Loại bỏ cơ chế ghi bộ đệm, tinh giản hàm `flush()` và thực hiện ghi đè/thêm mới file log trực tiếp theo thời gian thực một cách an toàn.
*   **Chặt chẽ hóa Kiểu dữ liệu (Type Safety)**:
    *   *Giải pháp*: Loại bỏ các kiểu dữ liệu lỏng lẻo `any` trong `daily-schedule-flow.helper.ts` và các Page Objects, thay thế bằng các import kiểu dữ liệu rõ ràng (ví dụ: `ServerHelper`, `ToastComponent`, `TestLogger`).
*   **Bổ sung hàm tiện ích trực tiếp vào Interface Page của Playwright (Monkey Patching)**:
    *   *Quyết định*: Để tránh việc liên kết quá chặt chẽ (tight coupling) và vi phạm nguyên tắc "các component con không kế thừa từ BasePage", phương thức `waitForLoadingToDisappear()` đã được đưa trực tiếp vào interface `Page` của Playwright thông qua `fixtures/page-factory.ts`. Việc này cho phép gọi `await this.page.waitForLoadingToDisappear()` an toàn ở bất kỳ đâu. Đồng thời thêm khối `.catch(() => {})` để tránh việc kiểm thử bị dừng đột ngột nếu hoạt ảnh loader tải quá nhanh hoặc không xuất hiện.
*   **Trình quản lý kết nối cơ sở dữ liệu dạng Pool (`pg.Pool`)**:
    *   *Sự cố*: Ban đầu `DatabaseHelper` sử dụng `pg.Client` và gọi kết thúc kết nối `.end()` ngay sau truy vấn đầu tiên, gây ra lỗi `Client has already been connected. You cannot reuse a client` ở các truy vấn tiếp theo.
    *   *Giải pháp*: Chuyển sang sử dụng `pg.Pool`, tự động quản lý vòng đời checkout, thực thi và giải phóng kết nối, cho phép chạy nhiều truy vấn đồng thời một cách an toàn.
*   **Tối giản hóa và Khắc phục lỗi hoạt động của Sidebar Component**:
    *   *Sự cố*: Logic điều hướng nhiều cấp của sidebar quá phức tạp (224 dòng code, sử dụng cơ chế kiểm tra tọa độ thay đổi `waitForStablePosition`, kiểm tra thuộc tính ẩn `display-none` và `aria-expanded` thường bị trễ hoặc sai lệch trạng thái thực tế do cơ chế định tuyến Single Page Application (SPA), khiến kịch bản kiểm thử bị chập chờn/flaky).
    *   *Giải pháp*: Viết lại và tối giản hóa `SidebarComponent` chỉ còn 120 dòng code. Component này hiện dùng trạng thái hiển thị thực tế của phần tử (`isVisible()`) làm nguồn dữ liệu chính xác duy nhất để quyết định khi nào cần click mở rộng menu cha. Nó tự động thử lại một lần nếu gặp trạng thái định tuyến SPA bị đơ khiến menu cấp 2 bị đóng thay vì mở rộng, đồng thời bao bọc toàn bộ các lệnh đợi trạng thái mạng rảnh (network idle) bằng khối `.catch(() => {})` để tránh lỗi đứt quãng không đáng có.
*   **Lỗi ghi đè Test Context (`saveTestContext` thành `updateTestContext`)**:
    *   *Sự cố*: Hàm `createAccountAndOrder()` gọi lệnh `saveTestContext()` (ghi đè toàn bộ) thay vì `updateTestContext()` (gộp/merge), làm mất đối tượng dữ liệu ngày thử nghiệm `testingDateObj` được tạo bởi TC-00.
    *   *Giải pháp*: Đổi sang sử dụng `updateTestContext()` để bảo toàn tất cả các thuộc tính context trên toàn bộ chuỗi kịch bản tuần tự. Không được gọi `saveTestContext()` ở giữa chuỗi kiểm thử.

---

## 4. Các sự cố đã biết & Cách khắc phục nhanh

*   **Độ ổn định của Sandbox API**: CRM Gateway API (`/processAccountAndOrder`) và backend GraphQL thỉnh thoảng mất kết nối và trả về lỗi `502 Bad Gateway`.
*   **Lỗi Tạo Work Order của Coope**: Trong bước thanh toán tại `TC-02`, API trả về phản hồi lỗi:
    `there is error while calling create work order api in Coope - EnviarSMS: The input string 'OR-xxxxxx' was not in a correct format.`
    Sự cố này được nghi ngờ là nguyên nhân gây lỗi cho quá trình tạo lệnh cấp dịch vụ (provisioning) tại `TC-03` khi nhấn nút "Create" cuối cùng không hiển thị thông báo thành công.

---

## 5. Trạng thái bàn giao & các bước tiếp theo

1.  **Triển khai Bypass Provisioning**: Luồng bỏ qua bước cấp dịch vụ qua database đang được phát triển và hoàn thiện. Phương thức `bypassProvisioning()` trong `helpers/db/provisioning.db.ts` kết hợp gọi API GraphQL và cập nhật trạng thái trong database trực tiếp. Luồng này đang được áp dụng và kiểm thử chính trong `ts-01.spec.ts`. Người tiếp nhận cần tiếp tục tinh chỉnh luồng này.
2.  **Xác minh Luồng Legacy**: Để tham chiếu luồng cũ, tệp `leagcy.spec.ts` lưu trữ toàn bộ kịch bản kiểm thử quy trình cấp dịch vụ bình thường qua UI (nhập dữ liệu wizard và đợi status Nokia FINALIZADO qua Customer Activity).
3.  **Cấu hình Pipeline CI/CD**: Khi môi trường sẵn sàng, cần thêm đầy đủ các biến môi trường `DB_HOST`, `DB_USER`, `DB_PASSWORD` vào cấu hình Variables trên GitLab CI.
4.  **Mở rộng tiếp các kịch bản Regression**: Sau khi ổn định cơ chế `bypassProvisioning`, tiếp tục triển khai các kịch bản liên quan đến cước nhắc nợ và suspend từ file tài liệu nghiệp vụ CSV.
