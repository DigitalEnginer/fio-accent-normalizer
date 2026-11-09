# Автоматическая нормализация ФИО и расстановка ударений

Конвейер, который принимает одну часть ФИО (имя, фамилию или отчество),
исправляет очевидные ошибки написания и ставит `+` перед ударной гласной —
для последующего синтеза речи.

```text
саңдк → сағынд+ық
аблае → абл+ай
```

## Как это работает

1. **GPT** распознаёт строку: оставляет как есть (`KEEP`), исправляет
   опечатку/раскладку/латиницу (`CORRECT`) или помечает как не-имя (`UNKNOWN`).
2. **Локальная модель** (символьный Transformer на PyTorch, ~157 тыс.
   параметров) расставляет ударения.
3. **Валидатор** проверяет формат результата.
4. **Оператор** подтверждает пачку: исправленные и сомнительные строки
   не применяются автоматически.

Подробное описание архитектуры, метрик и ограничений —
в [TECHNICAL_DOSSIER.md](TECHNICAL_DOSSIER.md).

## Структура репозитория

| Путь | Что внутри |
|---|---|
| [`name-normalizer/web/`](name-normalizer/web) | Веб-интерфейс (React + vinext), API нормализации, пакетная проверка, журнал (Drizzle + D1) |
| [`name-normalizer/web/scripts/`](name-normalizer/web/scripts) | Локальные сервисы: OpenAI-прокси, сервер модели ударений, RUAccent, подготовка данных и оценка |
| [`name-normalizer/docs/`](name-normalizer/docs) | Контракт MVP и описание пайплайна |
| [`kz-accent-model/`](kz-accent-model) | Обучение, оценка и инференс модели ударений |

## Данные и веса

Обучающие данные, производные наборы, отчёты с примерами и обученные
checkpoints **в репозиторий не входят**. Чтобы воспроизвести обучение,
нужен собственный CSV с парами «слово → слово с ударением»:

```text
"gold_name";"robot_name"
"пример";"прим+ер"
```

Положите его в корень как `names.csv`, затем:

```powershell
cd name-normalizer\web
python scripts\prepare_finetuning_data.py   # соберёт data/finetuning/names-clean.csv
cd ..\..\kz-accent-model
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe prepare_dataset.py
.\.venv\Scripts\python.exe train.py --profile laptop --split-strategy grouped --epochs 4
```

Все варианты запуска обучения и оценки — в
[kz-accent-model/README.md](kz-accent-model/README.md).

## Запуск веб-приложения

Требуется Node.js ≥ 22.13 и pnpm.

```powershell
cd name-normalizer\web
copy .env.example .env.local   # впишите свой OPENAI_API_KEY
pnpm install
pnpm dev
```

`pnpm dev` поднимает веб-интерфейс на `http://localhost:3000` и локальные
сервисы на портах 8765–8767. Для сервиса ударений нужен обученный checkpoint
в `kz-accent-model/artifacts/`.

## Тесты

```powershell
cd name-normalizer\web
pnpm test
```
