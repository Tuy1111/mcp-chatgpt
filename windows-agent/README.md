# Windows Code Agent — nối máy Windows của bạn với ChatGPT qua gateway

Chuỗi hoạt động:

    ChatGPT  ──OAuth──►  gateway (mcp.tuyng.online)  ──WebSocket──►  agent này (máy Windows)  ──►  code trên máy bạn

ChatGPT không bao giờ chạm thẳng vào máy bạn. Nó gửi yêu cầu tới gateway trên VPS,
gateway chuyển tiếp cho agent đang chạy trên máy Windows, agent thao tác đúng thư mục
code bạn cho phép rồi trả kết quả về. File không rời khỏi máy trừ đúng phần ChatGPT đọc/sửa.

## Yêu cầu
- Node.js 18 trở lên (bạn đã có).
- Thư mục code cần có file cấu hình `.code-agent.json` (mẫu ở dưới).

## Cài đặt (làm 1 lần)

1. Chép cả thư mục này về máy Windows, ví dụ `C:\win-code-agent`.
2. Mở **PowerShell** trong thư mục đó, cài thư viện:

       npm install

3. Vào thư mục code bạn muốn ChatGPT sửa, tạo file `.code-agent.json`. Ví dụ:

       {
         "name": "du-an-cua-toi",
         "allowedPaths": ["src/**", "test/**", "*.md", "package.json"],
         "blockedPaths": [],
         "commands": {
           "test": "npm test",
           "build": "npm run build"
         },
         "maxFileBytes": 512000,
         "writable": true
       }

   - `allowedPaths`: chỉ những file khớp mới được đọc/sửa.
   - `commands`: chỉ các lệnh liệt kê ở đây mới chạy được (qua `test_run`), spawn trực tiếp không qua shell.
   - `writable: false` nếu chỉ muốn cho đọc.
   - Bí mật (`.env`, `*.key`, `.git`, `node_modules`, `.ssh`...) **luôn bị chặn cứng**, không mở được.

## Chạy

    node agent.mjs --workspace-root "C:\duong-dan\toi\du-an"

Có thể chỉ nhiều thư mục:

    node agent.mjs --workspace-root "C:\du-an-1" --workspace-root "C:\du-an-2"

**Lần đầu** agent in ra một URL + mã pair. Mở URL trên trình duyệt, nhập **Owner password**,
bấm Approve. Agent lưu token vào `.agent-state.json` (mode 600) và tự kết nối. Các lần sau
không phải pair lại nữa.

Khi thấy dòng `Connected to gateway ... Waiting for ChatGPT requests.` là sẵn sàng.

## Dùng trong ChatGPT

Trong chat có bật connector, gõ ví dụ:

- "gọi machines_list"  → phải thấy máy của bạn, `online: true`
- "workspaces_list trên máy <tên>"  → liệt kê workspace
- "đọc file src/index.js"
- "sửa … trong file …"

## Tùy chọn (biến môi trường)

- `GATEWAY`     — mặc định `https://mcp.tuyng.online`
- `MACHINE_ID`  — tên máy (mặc định `win-<hostname>`); đổi nếu chạy nhiều máy
- `WORKSPACE_ROOTS` — thay cho `--workspace-root`, ngăn cách bằng `;` trên Windows
- `AGENT_STATE` — đường dẫn file lưu token (mặc định cạnh agent.mjs)

## Chạy nền / tự khởi động (Windows)

Cách đơn giản nhất là dùng **NSSM** (Non-Sucking Service Manager) để biến nó thành Windows Service:

1. Tải nssm.exe từ https://nssm.cc
2. PowerShell (quyền admin):

       nssm install WinCodeAgent "C:\Program Files\nodejs\node.exe" "C:\win-code-agent\agent.mjs --workspace-root C:\duong-dan\du-an"
       nssm set WinCodeAgent AppDirectory C:\win-code-agent
       nssm start WinCodeAgent

   Xem log: `nssm set WinCodeAgent AppStdout C:\win-code-agent\agent.log`

Hoặc chạy nhanh bằng Task Scheduler (chạy lúc đăng nhập) trỏ tới `node.exe` với tham số như trên.

## Gỡ pairing
Xóa file `.agent-state.json` rồi chạy lại — agent sẽ xin pair mới.
