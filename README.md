# ChatGPT Code MCP — Sample Setup

Repo mẫu tối giản để người dùng kết nối một máy local vào **ChatGPT Code MCP Gateway** và thử các thao tác đọc/tìm/sửa code từ ChatGPT.

> Repo này là **sample workspace**, không chứa Gateway hay Agent source. Bạn cần có một ChatGPT Code MCP Gateway đang chạy và `code-agent` từ project chính.

## Kiến trúc

```text
ChatGPT
   │ MCP
   ▼
MCP Gateway
   │ WebSocket
   ▼
code-agent trên máy bạn
   │
   ▼
repo sample này
```

## Yêu cầu

- Node.js 22+
- pnpm 9+
- Git
- ripgrep (`rg`) trong `PATH`
- Gateway ChatGPT Code MCP đã deploy/chạy
- Source project `chatgpt-code-mcp` để chạy agent

## 1. Clone sample

```bash
git clone <YOUR_SAMPLE_REPO_URL>
cd chatgpt-code-mcp-sample
pnpm install
```

Repo đã có `.code-agent.json`, vì vậy agent có thể nhận diện đây là một workspace.

## 2. Build agent ở project chính

Trong repo `chatgpt-code-mcp`:

```bash
pnpm install
pnpm build
```

## 3. Pair máy với Gateway

Từ thư mục `apps/agent` của project chính:

### Windows PowerShell

```powershell
pnpm start -- pair --machine-id my-pc --gateway https://YOUR_GATEWAY --workspace-root "C:/path/to/folder-containing-this-repo"
```

### macOS / Linux

```bash
pnpm start -- pair --machine-id my-pc --gateway https://YOUR_GATEWAY --workspace-root "$HOME/projects"
```

Mở URL mà CLI hiển thị, nhập pair code và approve. Token của agent được lưu ở config local; **không commit token vào Git**.

> Trên Windows nên dùng path với `/`, ví dụ `C:/Users/me/Projects`.

## 4. Chạy agent

```bash
pnpm start -- start
```

Giữ terminal này chạy. Kiểm tra nhanh bằng:

```bash
pnpm start -- status
pnpm start -- workspaces
```

Bạn sẽ thấy workspace `chatgpt-code-mcp-sample`.

## 5. Kết nối ChatGPT

Trong ChatGPT, thêm MCP server của bạn với endpoint:

```text
https://YOUR_GATEWAY/mcp
```

Hoàn tất OAuth theo cấu hình Gateway. Khi MCP được kết nối, thử các prompt:

```text
Liệt kê các máy đang online.
```

```text
Liệt kê workspace trên máy my-pc.
```

```text
Đọc file src/greeting.ts trong workspace chatgpt-code-mcp-sample.
```

```text
Sửa hàm greet để trả về "Hello, <name>! Welcome to MCP." rồi chạy test.
```

```text
Cho tôi xem git diff của workspace.
```

## Các tool bạn có thể demo

| Tool | Ví dụ |
|---|---|
| `machines_list` | Xem agent/máy online |
| `workspaces_list` | Xem workspace được expose |
| `directory_list` | Duyệt file |
| `file_read` | Đọc code + SHA-256 |
| `code_search` | Tìm code bằng ripgrep |
| `file_apply_patch` | Sửa file an toàn với SHA-256 |
| `file_create` | Tạo file |
| `file_delete` | Xóa file |
| `file_move` | Đổi tên/di chuyển file |
| `git_status` | Xem trạng thái Git |
| `git_diff` | Xem thay đổi |
| `test_run` | Chạy command test đã whitelist |

## Security của sample

`.code-agent.json` chỉ cho phép các file source/test và metadata cần thiết. Các file `.env`, secret, key và `node_modules` bị block.

Không đưa access token, agent token, `.env`, private key hoặc credential vào repo public.

## Test sample thủ công

```bash
pnpm test
pnpm build
```

## Đẩy repo lên GitHub

Thay `<YOUR_SAMPLE_REPO_URL>` trong README bằng URL thật, sau đó:

```bash
git init
git add .
git commit -m "chore: add ChatGPT Code MCP sample workspace"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/chatgpt-code-mcp-sample.git
git push -u origin main
```

## Project chính

Xem project `chatgpt-code-mcp` để biết cách self-host Gateway, OAuth, pairing và kiến trúc đầy đủ.
