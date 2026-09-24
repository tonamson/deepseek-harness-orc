# Plugin workflow ORC cho DeepSeek Harness

[English](README.md) | **Tiếng Việt**

`@tonamson2/dsh-orc` là một package bundle DSH duy nhất, thêm workflow ORC vào một
profile DeepSeek Harness: một run Supervisor → Lead → Peer với review và security
audit tách biệt, được định tuyến qua provider/model hoặc host CLI mà bạn chọn.

Bundle là package duy nhất người dùng cài. Nó mount hai dòng Loader — `orc-host`
(settings, journal, service `orc`, tool `orc`, policy, pre-step gate) và
`orc-remote-host` (Remote face) — cùng một trang cài đặt trên Web.

## Yêu cầu

| Yêu cầu | Giá trị |
|---|---|
| DSH | đúng `0.1.6-alpha.2` (xem [Các phiên bản DSH được hỗ trợ](#các-phiên-bản-dsh-được-hỗ-trợ)) |
| Node.js | 20 trở lên (yêu cầu của chính DSH CLI) |
| pnpm | `dsh plugin` cần để quản lý package của profile |
| Codex CLI (tùy chọn) | `0.156.1` trở lên, khi bạn chọn backend subscription Codex |
| Claude Code CLI (tùy chọn) | `2.1.280` trở lên, khi bạn chọn backend subscription Claude Code |

Chỉ CLI mà bạn thực sự chọn là bắt buộc. Phiên bản CLI mới hơn không có giới hạn
trên cố định, nhưng ORC chạy lại probe về phiên bản, xác thực và khả năng trước
mỗi lần dispatch, và từ chối phiên bản nào không vượt qua probe đó.

Một mức tối thiểu về phiên bản **không phải** là bằng chứng hợp lệ. Review và audit
high-risk chỉ chấp nhận một route khi phiên bản live của nó **bằng đúng** phiên bản
mà một benchmark record đã đo, nên Claude Code `2.1.280` và bất kỳ Codex nào mới
hơn `0.156.1` sẽ mất route high-risk cho tới khi bạn đo chính phiên bản đó — xem
[Bằng chứng benchmark](#bằng-chứng-benchmark).

## Cài đặt

Cài package bundle duy nhất vào một profile Web:

```sh
dsh plugin --profile web add @tonamson2/dsh-orc
```

Từ bản build cục bộ, cài tarball đã pack bằng đường dẫn tuyệt đối:

```sh
npm pack
dsh plugin --profile web add file:/absolute/path/to/tonamson2-dsh-orc-0.1.0.tgz
```

Cũng có thể cài từ trang **Plugins** của DSH. Việc cài đặt sẽ chọn bundle layer và
kích hoạt cả hai dòng ORC.

## Bật và tắt

Tắt bundle sẽ gỡ mọi đóng góp runtime — service `orc`, tool `orc`, policy ra quyết
định, journal projection và trang cài đặt ORC — mà vẫn giữ nguyên phần còn lại của
profile, standard preset, global model default và provider credential. Bật lại sẽ
khôi phục chúng. Gỡ package sẽ xoá nó khỏi profile.

- Trang Plugins: bật/tắt bundle `@tonamson2/dsh-orc`.
- File profile: thêm hoặc bỏ `@tonamson2/dsh-orc` trong
  `$DSH_HOME/profiles/web/package.json` tại `dsh.profile.bundles`, rồi khởi động
  lại profile.

Bundle không bao giờ sửa file profile do DSH ship, standard preset, global model
default hay provider credential, và nó chỉ lưu tham chiếu route cùng policy —
không bao giờ lưu credential.

## Hành vi phiên làm việc

Model và provider bạn chọn trong chat vẫn là **Supervisor** cho phiên đó. Bật ORC
không thay thế preset đã chọn, không đổi model, không đổi global default; Lead và
các Peer của run kế thừa route provider/model đang sống của Supervisor.

Chế độ ORC của phiên quyết định việc mở run sớm đến đâu:

- **Adaptive** (mặc định): phân loại bên dưới quyết định.
- **Always**: một run ORC mở cho mọi request được chấp nhận, dù nhỏ đến đâu —
  pre-step gate chỉ nhìn thấy phần text của request, nên nó không đoán xem một
  request có thật sự đơn giản hay không mà tôn trọng chế độ bạn đã chọn.

Trước khi triển khai, Supervisor phân loại request:

- Việc nhỏ, tách biệt, rủi ro thấp — một lỗi chính tả, một chỉnh sửa tài liệu nhỏ,
  một điều chỉnh giao diện gọn trong một chỗ — có thể xử lý trực tiếp, không cần
  trạng thái ORC.
- Việc nhiều bước, nhiều file, mang tính kiến trúc, được yêu cầu lập kế hoạch rõ
  ràng hoặc review rõ ràng sẽ khởi động ORC.
- Thay đổi liên quan đến dòng tiền, số dư, thanh toán, xác thực, phân quyền và các
  thay đổi nhạy cảm về bảo mật **luôn** khởi động ORC, dù diff nhỏ đến đâu.
- Nếu công việc trực tiếp bộc lộ phạm vi lớn hoặc rủi ro cao trước khi triển khai,
  Supervisor sẽ escalate sang ORC trước khi tiếp tục.

Khi ORC đã khởi động, review và security audit là hai stage tách biệt. Finding ở mức
critical, high và medium sẽ chặn cho tới khi được sửa và review lại. Một báo cáo
thất bại, sai định dạng, thiếu hoặc không có đều mang tính chặn và không bao giờ
được biểu diễn như một audit sạch: ORC nêu rõ định dạng báo cáo yêu cầu cho từng
backend review và audit mà nó dispatch tới, và một báo cáo sai định dạng để run vẫn
bị chặn ở đúng stage đó, nên có thể dispatch lại chính stage ấy sau khi đã sửa
nguyên nhân.

Một child của ORC — dù là Lead hay Peer — không thể hỏi người dùng: DSH từ chối mọi
tương tác với con người đối với agent do một agent khác sở hữu, nên
`ask_user_question` không khả dụng với chúng. Khi một Peer cần quyết định mà chỉ
người dùng mới đưa ra được, nó nêu câu hỏi qua tool ORC rồi chờ, và run tạm dừng —
review, final review và việc settle task đó đều bị từ chối cho tới khi câu hỏi được
trả lời. Supervisor đặt câu hỏi cho người dùng và trả lời, rồi ORC chuyển câu trả
lời đến đúng peer đã nêu câu hỏi. Lead không sở hữu task nào, nên nó nêu quyết định
mình cần trong final result thay vì nêu câu hỏi.

## Cấu hình

Trang ORC nằm trong mục cài đặt trên Web và chỉ sở hữu namespace `orc`. Trang cấu
hình:

- hành vi ORC theo phiên (`adaptive` hoặc `always`) và policy rủi ro trực tiếp so
  với ORC;
- route triển khai code, mặc định là provider/model DeepSeek Flash v4.1 đã cấu hình
  ở effort high khi có sẵn. **Route này chỉ chi phối một việc duy nhất: một
  `dispatch` tường minh với `stage: 'code'`.** Lead và Peer của run thay vào đó kế
  thừa route bạn đã chọn trong chat, vì một DSH child agent chỉ có thể được cấp một
  route provider của DSH — backend chọn qua CLI không bao giờ tới được đó;
- các backend được phép, và gán thủ công (**Manual**) theo từng stage (spec, plan,
  review, audit) hoặc định tuyến tự động (**Auto**);
- một ô nhập route dạng **văn bản tự do**, để trang có thể allowlist một route mà
  catalog live chưa khám phá ra — kể cả trên một bản cài mới, nơi không có gì được
  khám phá và chưa route nào được cấu hình;
- tham chiếu provider/model của DSH hoặc chọn CLI Codex/Claude Code;
- đường dẫn executable của CLI khi nó không được tìm thấy trên `PATH`, kèm kết quả
  health/authentication của CLI;
- các giới hạn của Auto routing và một mức trần chi phí tùy chọn.

Auto routing dùng catalog provider/CLI đang sống và bằng chứng benchmark có phiên
bản của ORC, đồng thời ghi lại đúng catalog snapshot và benchmark record đứng sau
mỗi quyết định. **Các tuyên bố chính thức về khả năng và giá được ghi lại thì chưa
được triển khai**: mọi entry trong catalog mang `sourceUrl` rỗng, và `retrievedAt`
là thời điểm ORC quan sát route đang sống, không phải thời điểm một nguồn được lấy
về. Bằng chứng khả năng duy nhất ORC dùng là probe đang sống của chính route đó
(phiên bản, xác thực và một lần chạy khả năng vô hại), và chi phí duy nhất nó dùng
là chi phí đo được của một benchmark record. Một model mới xuất hiện không đủ điều
kiện cho review hoặc audit high-risk cho tới khi có bằng chứng benchmark cần thiết.
Nếu không route nào được phép đạt ngưỡng chất lượng của stage, stage sẽ dừng và đề
nghị bạn cấu hình một route khác.

### Kiểm tra kết nối provider

Kiểm tra kết nối gửi một request tối thiểu, vô hại qua provider/model đã chọn.
Trang cảnh báo trước khi gửi:

> This test may use provider quota or incur cost

Một kết quả xanh được gắn với đúng revision provider/model/cấu hình đã kiểm tra;
mọi thay đổi cấu hình liên quan đều vô hiệu hoá nó. Một lần test xanh không bảo
đảm khả năng sẵn sàng trong tương lai, và một lỗi xác thực, mạng, quota hay dịch vụ
về sau vẫn là một task failure.

### Các trạng thái lỗi

Cấu hình thiếu hoặc không hợp lệ, provider không khả dụng, kiểm tra kết nối thất
bại, phiên bản CLI không được hỗ trợ, probe khả năng thất bại và thiếu xác thực đều
được hiển thị dưới dạng lỗi có thể hành động được. Một lỗi xảy ra sau khi test thành
công vẫn là task failure: ORC không bao giờ âm thầm chuyển sang provider, model hay
CLI khác, và không bao giờ fallback về một runtime đóng gói sẵn.

Một **route refusal** không phải là run failure. Khi không route nào được phép đạt
được quy tắc về bằng chứng, chi phí hoặc tính độc lập của một stage, stage sẽ dừng
với lỗi có thể hành động được là `no-qualifying-route` / `no-independent-route` /
`no-code-route`, và run giữ nguyên phase của nó, nên bạn có thể cấu hình một route
hoặc tạo bằng chứng còn thiếu rồi dispatch lại chính stage đó — không cần khởi động
lại, không mất công việc đã làm. Mọi lỗi định tuyến khác, ví dụ một lỗi khám phá
provider, vẫn mang tính chặn.

**Mỗi phiên chỉ có một run ORC, và một run thất bại hoặc đã hoàn tất sẽ kết thúc
ORC cho phiên đó.** `OrcService.start` trả về run mà phiên đã ghi lại mỗi khi một
run đã bắt đầu, nên một phiên đã chạy ORC không thể bắt đầu run thứ hai. Phase
`failed` là terminal, và `completed` cũng vậy: do đó chỉ một lỗi provider hoặc CLI
tạm thời trong lúc dispatch cũng kết thúc ORC ở phiên đó, và cách duy nhất để phục
hồi là mở một phiên chat mới. Route refusal (ở trên) và báo cáo bị từ chối là những
trường hợp có thể phục hồi tại chỗ — chúng để run ở nguyên phase, nên có thể dispatch
lại chính stage đó.

## Bằng chứng benchmark

Bundle ship các fixture về bug đã biết và false-positive trong `benchmarks/`, cùng
runner chấm điểm một route dựa trên chúng trong `scripts/`. Kiểm tra manifest fixture
không cần key — không model, không mạng, không credential:

```sh
node scripts/benchmark.mjs --verify-fixtures
```

**Điểm số đo cái gì.** Prompt của mỗi fixture đưa ra danh sách candidate finding id
của chính fixture đó — đúng bộ từ vựng mà bộ chấm điểm chấp nhận — và mọi danh sách
đều trộn các id có bug hiện diện trong code (đúng bằng tập `expected` đã seed của
fixture) với các distractor id trông hợp lý nhưng vắng mặt. Một fixture sạch không
được thông báo là không có candidate: nó cũng đưa ra một danh sách distractor không
rỗng. Do đó điểm số là một phép đo **nhận diện kèm distractor**: nó cho biết route
được chọn có báo đúng (những) bug đã seed đang hiện diện *và* có loại bỏ các
candidate vắng mặt được đưa kèm hay không — đó là lý do vì sao việc lặp lại toàn bộ
bộ từ vựng giờ tạo ra false positive thay vì điểm tuyệt đối.

Nó **không phải** là điểm đo độ chính xác review tự do. Một finding đúng nhưng được
báo dưới một định danh nằm ngoài bộ từ vựng được đưa ra sẽ không được tính, nên con
số này không nói lên điều gì về cách một route đặt tên, xếp hạng hay giải thích vấn
đề trên code thật, và cũng không nói lên liệu nó có thể phát hiện một bug thật mà bộ
suite không seed hay không. Hãy đọc nó như một ngưỡng sàn về khả năng phân biệt,
không phải một bảng xếp hạng chất lượng.

**Bundle ship hai record đã đo**, và chính cặp này làm cho đường high-risk trở nên
hoàn chỉnh. `benchmarks/evidence/` chứa
`codex_gpt-6-sol_high_2026-09-24T02_44_02.851Z.json` (backend `codex`, model
`gpt-6-sol`, effort `high`, phiên bản backend `0.156.1`, detection `1.0`,
false-positive `0.2`) và
`claude_claude-sonnet-5_high_2026-09-24T03_09_19.373Z.json` (backend `claude`,
model `claude-sonnet-5`, effort `high`, phiên bản backend `2.1.281`, detection
`1.0`, false-positive `0.0`). Mỗi record còn ghi ngày đo, suite revision
`orc-review-v1`, các scope mà nó bao phủ (`financial` và `security`), cùng độ trễ
và chi phí đo được.

Hai record được ship vì **một review high-risk và audit đi kèm của nó phải chạy
trên hai backend khác nhau**: audit phải độc lập với review. Với chỉ một backend
đủ điều kiện bằng chứng, audit sẽ bị từ chối với `no-independent-route`, nên chính
cặp record này cho phép một bản cài mới chạy trọn cổng money/security.

Tính hợp lệ đòi hỏi **phiên bản bằng đúng nhau**: một record chỉ khớp một route khi
`backendVersion` của nó bằng quan sát của catalog live cho đúng backend, model và
effort đó, ngày của nó nằm trong `catalogMaxAgeDays`, và scope của nó bao phủ các
vùng rủi ro được yêu cầu. Vì vậy các mức tối thiểu CLI được ghi trong tài liệu
không phải là bằng chứng. Claude Code `2.1.280` — mức tối thiểu mà bundle này hỗ trợ
— và bất kỳ Codex nào mới hơn `0.156.1` đều không khớp với các record được ship, nên
những route đó bị loại khỏi review và audit high-risk cho tới khi bạn đo chúng bằng
runner bên dưới. Đó là hành vi fail-closed, không phải lỗi: một phiên bản chưa được
đo có thể hành xử khác.

**Hai record được ship hết hạn vào 2026-10-01.** Chúng được đo ngày 2026-09-24 và
`catalogMaxAgeDays` mặc định là 7, nên từ 2026-10-01 chúng không còn mới, và mọi
review cùng audit high-risk sẽ fail-closed với `no-qualifying-route` cho tới khi các
route được đo lại. Hãy đo lại cả hai route được ship bằng runner — phiên bản phải là
đúng phiên bản mà CLI đã cài báo cáo:

```sh
node scripts/benchmark.mjs \
  --backend codex --model gpt-6-sol --effort high --version 0.156.1 \
  --command codex --arg exec --arg --json --arg -

node scripts/benchmark.mjs \
  --backend claude --model claude-sonnet-5 --effort high --version 2.1.281 \
  --command-json '["claude","--print","--output-format","json","--model","claude-sonnet-5","--effort","high"]'
```

Mỗi điểm số là một phép đo, không phải một lời hứa. Nó được lấy trên một máy, một
tài khoản và một bản build CLI cụ thể, đối chiếu với đúng suite revision này, nên một
record là bằng chứng rằng route chính xác đó đã vượt qua các ngưỡng — không phải một
bảo đảm chất lượng chung về model, và không phải một tuyên bố về bất kỳ route nào
khác. Một bundle hoàn toàn không có thư mục evidence vẫn tạo ra snapshot rỗng
fail-closed, tức là từ chối review và audit high-risk bằng `no-qualifying-route` thay
vì chấp nhận một route chưa được đo.

**Một route provider của DSH không bao giờ có thể phục vụ review hoặc audit
high-risk.** Catalog provider đang sống không để lộ phiên bản backend — mọi entry
catalog provider ghi `backendVersion` rỗng — trong khi tính hợp lệ đòi hỏi một phiên
bản thật, khác rỗng và bằng đúng quan sát live đó (R22). Không record nào bạn tạo ra
có thể thay đổi điều đó, vì không có phiên bản provider nào để một record khớp vào;
đường đó được phục vụ bởi một host CLI (Codex hoặc Claude Code), nơi catalog live có
mang phiên bản. Các route provider vẫn dùng được cho `spec`, `plan`, `code`, và cho
một review hoặc audit mà bộ phân loại không đánh dấu là high-risk.

Hãy tạo thêm một record có phiên bản cho mỗi route **host CLI** mà bạn muốn định
tuyến review và audit high-risk tới. Từ một lần chạy đã ghi lại:

```sh
node scripts/benchmark.mjs \
  --backend codex --model gpt-5.2-codex --effort high --version 0.156.1 \
  --responses recorded-responses.json
```

Hoặc bằng cách gọi trực tiếp CLI đã chọn. argv là tường minh và không bao giờ được
nội suy qua shell: truyền executable bằng `--command` và từng đối số bằng một `--arg`
lặp lại riêng, hoặc truyền cả argv dưới dạng JSON bằng `--command-json`. Prompt của
fixture vẫn nằm trên stdin trong cả hai dạng.

```sh
node scripts/benchmark.mjs \
  --backend codex --model gpt-5.2-codex --effort high --version 0.156.1 \
  --command codex --arg exec --arg --json --arg -

node scripts/benchmark.mjs \
  --backend claude --model claude-opus-4-1 --effort high --version 2.1.281 \
  --command-json '["claude","--print","--output-format","json","--model","claude-opus-4-1","--effort","high"]'
```

**Các định dạng output mà runner hiểu.** Trước khi tìm các dòng `FINDING:`, runner
rút gọn stdout của một lần gọi đã spawn về phần text cuối cùng được chấp nhận của
assistant. Có ba dạng được hiểu:

- **Claude Code `--output-format json`** — một JSON object duy nhất có `type` là
  `result`; câu trả lời là chuỗi `result` của nó, được JSON-decode để các ký tự
  xuống dòng đã bị escape trở thành dòng finding thật. Đây chính là dạng mà ORC
  dispatch tới Claude (`--output-format json`; xem `claudeArgv` trong
  `src/host/cli.ts`), và dạng này đã được xác nhận với một lần gọi `claude` `2.1.281`
  thật. Một `is_error: true`, một `subtype` khác `success`, hoặc một `result` bị
  thiếu hay không phải chuỗi sẽ làm lần chạy của fixture đó thất bại; một `result`
  rỗng là câu trả lời "không báo gì" thật sự và cho điểm 0 mà không thất bại.
- **Codex `--json` JSONL** — một event object trên mỗi dòng stdout. Câu trả lời là
  `text` của event `item.completed` có item type là `agent_message`, với các ký tự
  xuống dòng đã bị JSON escape được decode; mọi event không phải assistant đều bị bỏ
  qua. Một event `turn.failed` hoặc `error` ở cấp cao nhất sẽ làm lần chạy của fixture
  đó thất bại.
- **Văn bản thuần** — toàn bộ stdout là câu trả lời. Đây là thứ `claude --print` phát
  ra ở `--output-format text`, và là thứ `codex exec` phát ra khi không có `--json`.

Một stdout mở đầu bằng một JSON object được coi là một lần thử envelope, không bao
giờ là văn bản thuần: JSON sai định dạng, hoặc một JSON object không khớp dạng nào ở
trên, **sẽ làm run thất bại**, nêu rõ fixture và các định dạng được hỗ trợ. Nó không
bao giờ bị đọc như văn bản thuần rồi âm thầm cho điểm 0 finding.

Một lần gọi thoát với mã 0 nhưng **không rút ra được text assistant nào sẽ làm run
thất bại** và không ghi record nào; nó không bao giờ được cho điểm như một kết quả
không có finding (sạch). Một báo cáo rút ra được nhưng **rỗng vẫn cho điểm 0
finding**, đây là cách đọc đúng cho một fixture sạch. Hai điều này được cố ý phân
biệt, để một `--command` chỉ định sai sẽ thất bại ồn ào thay vì âm thầm tạo ra một
điểm 0 không hợp lệ.

`--version` là bắt buộc cho một lần chạy tính điểm: một evidence record có
`backendVersion` rỗng không bao giờ hợp lệ, nên runner từ chối ghi nó. Runner không
bao giờ đoán một route, không bao giờ tự gọi model, và không bao giờ fallback sang
backend khác. Record được ghi vào `benchmarks/evidence/` — thư mục mà bundle ship,
cùng với record của chính nó — và được Host đọc khi profile tải, nên hãy khởi động
lại profile sau khi tạo chúng.

## Các phiên bản DSH được hỗ trợ

Bản phát hành này hỗ trợ **đúng `@deepseek-ai/dsh*` `0.1.6-alpha.2`** — phiên bản tối
thiểu và phiên bản mới nhất đã kiểm thử là một. Không có dải hỗ trợ: DSH
`0.1.7-alpha.2` đã gỡ `ctx.settings.installSection` và `ctx.settingsScope`, là những
thứ mà thiết kế cài đặt của bundle này cần, nên nó **không được hỗ trợ**. Các phiên
bản package vượt qua kiểm thử và các extension contract chính xác được ghi lại trong
[`docs/compatibility.md`](docs/compatibility.md). Một bản DSH nằm ngoài tập được hỗ
trợ sẽ không được hỗ trợ cho tới khi các kiểm tra tích hợp của ORC vượt qua và tập đó
được cập nhật.

## Hạn chế đã biết

1. **ORC Remote face được mount bởi chính client plugin của bundle này, và không gì
   khác.** Web client assembly của DSH value-import một danh sách `/remote` artifact
   cố định tại thời điểm build và không khám phá gì lúc runtime, nên `ctx.remote.orc`
   không tồn tại trong một profile sạch cho tới khi client plugin của ORC tự mount
   đóng góp viết tay của nó qua API công khai `ctx.remote.$mount(...)`. Đó chính xác
   là điều plugin được ship làm, nên trang cài đặt đọc được catalog live, probe được
   một route và hiển thị health của CLI trong một profile Web sạch. Vẫn còn hai hệ
   quả. `./typert` và `./remote` vẫn cố ý **không** được khai báo là package export:
   Typert loader thất bại ồn ào khi một artifact được khai báo nhưng thiếu, và
   generator đã publish không thể build chúng cho một package bên ngoài — thay vào
   đó đóng góp là dữ liệu thuần viết tay, được client Gateway kiểm tra về cấu trúc.
   Và một profile không mount bất kỳ Remote client service nào sẽ hiển thị trạng thái
   tường minh của trang: *"The ORC remote face is unavailable in this profile"* —
   trang vẫn hoạt động ở đó, vì ô nhập route của nó không phụ thuộc vào catalog. Bằng
   chứng: mục Step 3a trong [`docs/compatibility.md`](docs/compatibility.md).
2. **Một phiên đã chạy ORC không thể được resume bởi DSH `0.1.6-alpha.2`.** Các event
   `orc/*` của ORC nằm ngoài `KNOWN_SESSION_EVENT_TYPES` của DSH, và cơ chế tương
   thích duy nhất là marker `SessionEvent.ignorable` được persist, thứ mà
   `Session.append` không thể đặt. Do đó một phiên có log chứa event `orc/*` sẽ không
   resume được cho tới khi DSH mở ra một đường append cho phép ignorable.
3. **Hai record benchmark được ship hết hạn vào 2026-10-01.** Chúng đề ngày
   2026-09-24 và `catalogMaxAgeDays` mặc định là 7, nên từ 2026-10-01 mọi review và
   audit high-risk đều fail-closed với `no-qualifying-route` cho tới khi các route
   được đo lại bằng runner (xem [Bằng chứng benchmark](#bằng-chứng-benchmark)).
4. **Mỗi phiên chỉ một run ORC.** Một phiên có run ORC đã đạt `failed` hoặc
   `completed` không thể bắt đầu run khác: `OrcService.start` trả về run hiện có, và
   cả hai phase đều terminal. Do đó chỉ một lỗi provider hoặc CLI tạm thời trong lúc
   dispatch cũng kết thúc ORC cho phiên đó, và cách phục hồi duy nhất là một phiên
   chat mới. Route refusal và báo cáo bị từ chối thì có thể phục hồi tại chỗ, vì
   chúng để run ở nguyên phase.

## Phát triển

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run pack:check
node scripts/clean-profile-smoke.mjs "0.1.6-alpha.2"
```

Script smoke pack bundle, cài nó vào một profile Web dùng một lần qua `dsh plugin`,
boot profile đó ở chế độ headless (cổng tạm thời, không trình duyệt) để điều khiển
các thao tác enable/disable thật của Plugin Manager cùng báo cáo restart-required của
chúng, thực hiện việc gỡ bỏ, và chạy trọn workflow ORC bằng input giả không cần key.
Nó không bao giờ gọi một model provider, và nó dọn thư mục mà nó đã tạo cả khi thất
bại lẫn khi thành công. `dsh plugin` chuyển tiếp tới pnpm, nên pnpm phải có trên
`PATH`; CI cung cấp một phiên bản được pin tường minh (`.github/workflows/ci.yml`)
thay vì dựa vào image của runner.

`tests/integration/*` kiểm tra archive đã pack, nên chúng build `lib/` trước khi
pack — `npm test` là tự chứa và không bao giờ kiểm thử một bản build cũ.

## Phát hành

Package đang là `private: true` và **không** được publish bởi automation của
repository này. Việc publish cần một chỉ thị phát hành tường minh; bundle phải dùng
một scope do nhà phát hành kiểm soát và không được mạo danh scope `@deepseek-ai`.
