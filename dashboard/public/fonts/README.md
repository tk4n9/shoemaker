# Fonts

- **Pretendard** (v1.3.9), the text font: `pretendard/` is the variable font's
  dynamic subset from the `pretendard` npm package, unchanged. Its stylesheet
  declares 92 `@font-face` subsets by Unicode range, so a page downloads only
  the subsets its characters need, Korean included. Copyright 2021 Kil
  Hyung-jin, with Reserved Font Name Pretendard.
- **Atkinson Hyperlegible Mono** (v8), for numbers and code: the
  variable-weight files served by Google Fonts, Latin and Latin Extended
  subsets. Copyright 2020-2024 The Atkinson Hyperlegible Mono Project Authors.

Both are licensed under the SIL Open Font License 1.1; the licence texts are
in this folder.

`src/core/layout.js` links Pretendard's stylesheet, and `app.css` declares the
mono font with `@font-face`, so the dashboard serves its own fonts rather than
loading them from a font service.
