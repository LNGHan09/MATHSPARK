# MathSpark Exam Grading UX Patch

## Included files
- `server.js`: strengthens written-answer feedback and asks AI for step-by-step explanations for incorrect MCQs whose saved question has no solution. If this explanation call fails, submission and automatic MCQ scoring continue; the result marks the explanation as unavailable rather than blocking submission.
- `index.html` and `public/index.html`: add the grading overlay and result display rules. Correct MCQs only show a concise correctness note; incorrect MCQs show the selected/correct answer and a solution when available. Written answers retain score, specific mistakes, corrected approach, and reference solution.

## Apply
1. Unzip into the MathSpark project root, preserving the `public/` path, and overwrite the three files.
2. Commit and push so Render deploys `server.js` and the updated frontend.
3. No SQL migration is required.

## Behavior
When the student submits, a blocking status overlay says “Bài làm của bạn đang được chấm, xin đợi trong giây lát”. It remains visible while the server grades and the result content is rendered, then closes automatically and the page scrolls smoothly to the results section. If the request errors, it closes and the student sees the existing error feedback.
