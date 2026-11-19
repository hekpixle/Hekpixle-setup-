# Hekpixle v0.14

ایجنت شخصی دسکتاپ (Electron). در این نسخه قابلیت‌های **Hermes Agent** به Hekpixle اضافه شد: دیدن و کنترل صفحه، مرورگر خودکار، جستجوی وب، اجرای کد، MCP، skills خودآموز، کارهای زمان‌بندی‌شده، زیرایجنت‌ها و بیشتر.

## اجرا
```
npm install        # electron + electron-builder (undici کنار پوشه هست)
npm start          # اجرای توسعه
build.bat          # ساخت installer ویندوز
```
چند پروفایل مجزا: `Hekpixle.exe --profile=work` (تنظیمات، حافظه و skills جدا).

## قابلیت‌ها (۴۵+ ابزار، در ۱۶ toolset که از Settings → Tools روشن/خاموش می‌شن)

| Toolset | ابزارها |
|---|---|
| **desktop** | `computer` (اسکرین‌شات، کلیک/دابل‌کلیک/راست‌کلیک، درگ، اسکرول، تایپ یونیکد/فارسی، کلید، zoom، فهرست/فوکوس پنجره)، `ui_tree` + `ui_act` (کنترل دقیق المان‌های برنامه با UI Automation ویندوز، بدون نیاز به vision)، `launch_app`، `focus_app` |
| **browser** | Chromium واقعی با login ماندگار: `browser_navigate/snapshot/click/type/select/press/scroll/back/screenshot/tabs/console/eval/wait/close` (المان‌ها با ref مثل `e12`) |
| **web** | `web_search` (DuckDuckGo بدون کلید، Tavily، Brave، SearXNG)، `web_extract` |
| **files** | `list_dir` (درخت پوشه با depth، سایز و تاریخ)، `path_info`, `read_file` (offset/limit)، `write_file`, `patch` (ویرایش دقیق)، `search_files` (محتوا/نام)، `make_dir`, `copy_path`, `move_or_rename` (بین درایوها هم)، `delete_path` (سطل زباله)، `file_history` + `file_restore` (rollback خودکار). مسیرها: `~`، `%USERPROFILE%`، Desktop/Documents/Downloads، نسبی (به workspace) |
| **terminal** | `run_command` (timeout، پس‌زمینه، تشخیص دستور خطرناک)، `process` (list/log/write/wait/kill) |
| **code** | `execute_code` (JavaScript داخلی یا Python) با دسترسی به ابزارها از داخل اسکریپت (`await tools.read_file(...)`) |
| **vision / media** | `vision_analyze`, `image_generate`, `text_to_speech`, `transcribe_audio` |
| **memory** | `save_memory`, `recall_memory`, `forget_memory`, `session_search` (جستجو در چت‌های قبلی) |
| **skills** | `skills_list`, `skill_view`, `skill_manage` — ایجنت خودش بعد از کارهای پیچیده skill می‌سازه/اصلاح می‌کنه (فرمت SKILL.md سازگار با agentskills.io) |
| **planning** | `todo`, `clarify` (پرسیدن سؤال با دکمه‌های انتخاب) |
| **delegation** | `delegate_task` — تا ۳ زیرایجنت موازی با کانتکست تازه |
| **cron** | `cronjob` — «هر روز ۹ صبح…»، `every 30m`، `in 2h`، cron پنج‌فیلدی؛ خروجی به اعلان دسکتاپ / تلگرام / لاگ |
| **messaging** | `send_message` به تلگرام |
| **mcp** | هر سرور MCP (stdio یا HTTP) از Settings → Tools → JSON |
| **plugins** | از Settings → Plugins (افزودن فایل/پوشه، نوشتن کد، روشن/خاموش، حذف) یا فایل `.js` در پوشه‌ی plugins با `api.registerTool` و hookهای `pre_tool_call` / `post_tool_call` / `system_prompt` |

سایر بخش‌ها: فشرده‌سازی خودکار تاریخچه‌ی طولانی (و دستور `/compress`)، `SOUL.md` (شخصیت) و `AGENTS.md` (دستورات پروژه) در پوشه‌ی داده یا workspace، حالت approval (`manual`/`off`) و دکمه‌ی «همیشه برای این ابزار»، پیام صوتی و عکس در تلگرام، `/sethome` برای دریافت نتیجه‌ی کارهای زمان‌بندی‌شده.

## امنیت
- هر کار حساس (کنترل ماوس/کیبورد، نوشتن فایل، اجرای دستور/کد، eval در مرورگر…) با کارت تأیید می‌پرسه. کنترل صفحه یک‌بار در هر اجرا می‌پرسه.
- دستورهای خطرناک (حذف بازگشتی، format، shutdown، force-push…) **همیشه** می‌پرسن و هیچ‌وقت از تلگرام/cron اجرا نمی‌شن.
- از تلگرام و کارهای زمان‌بندی‌شده فقط ابزارهای مجاز طبق Settings اجرا می‌شن؛ نوشتن/حذف به‌طور پیش‌فرض بسته‌ست.
- اسکرین‌شات‌ها برای مدل ارسال می‌شن؛ اگه مدل شما vision نداره در Settings → Tools «مدل بینایی جدا» تنظیم کنید.
- `web_extract` آدرس‌های محلی/شبکه‌ی داخلی رو مسدود می‌کنه.

## نیازمندی‌ها و نکات
- کنترل ماوس/کیبورد و `ui_tree` برای **ویندوز** نوشته شده (PowerShell)؛ لینوکس با `xdotool`، مک با `cliclick` پایه‌ای پشتیبانی می‌شه. مرورگر، وب، فایل، کد و بقیه چندسکویی‌ان.
- `execute_code` با Python نیاز به نصب Python دارد؛ JavaScript بدون نصب کار می‌کنه.
- مدل اصلی باید tool-calling پشتیبانی کنه (و برای دیدن اسکرین‌شات، vision).
- تولید تصویر/صدا/رونویسی از API سازگار با OpenAI استفاده می‌کنن (آدرس و کلید جدا در Settings → Tools).
- هنوز نیست: درگاه‌های Discord/Slack/WhatsApp/Signal/Email، بک‌اندهای ترمینال Docker/SSH، حالت صوتی زنده در دسکتاپ.

## ساختار
`main.js` (هسته، حلقه‌ی ایجنت، رجیستری ابزار) · `lib/` (ماژول‌های ابزار) · `skills_seed/` (skillهای اولیه) · `telegram.js` · `renderer/`
