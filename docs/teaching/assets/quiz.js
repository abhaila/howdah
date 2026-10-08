/* Reusable retrieval-practice widget. Used by every lesson in this workspace.
 *
 * Markup contract:
 *   <div class="q" data-answer="Noul">
 *     <p class="q-stem">…the question…</p>
 *     <div class="q-opts"><button>Choice</button><button>Score</button><button>Noul</button></div>
 *     <div class="q-why" hidden>…why, revealed after answering…</div>
 *   </div>
 *
 * Options are shuffled on load and must carry no formatting clue — same word count, same
 * casing. Only the FIRST press counts: this is retrieval practice, not multiple guesses.
 */
(function () {
  const shuffle = (parent) => {
    const kids = [...parent.children];
    for (let i = kids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [kids[i], kids[j]] = [kids[j], kids[i]];
    }
    kids.forEach((k) => parent.appendChild(k));
  };

  const score = () => {
    const out = document.getElementById("q-score");
    if (!out) return;
    const all = document.querySelectorAll(".q").length;
    const done = document.querySelectorAll(".q.answered").length;
    const right = document.querySelectorAll(".q.answered.right").length;
    out.textContent = done === all
      ? `${right} of ${all} right first time.`
      : `${done} of ${all} answered.`;
  };

  document.querySelectorAll(".q").forEach((q) => {
    const opts = q.querySelector(".q-opts");
    const want = q.dataset.answer.trim();
    if (opts) shuffle(opts);
    opts?.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        if (q.classList.contains("answered")) return; // first answer is the only one that counts
        const correct = b.textContent.trim() === want;
        q.classList.add("answered", ...(correct ? ["right"] : []));
        b.classList.add(correct ? "ok" : "bad");
        if (!correct) {
          opts.querySelectorAll("button").forEach((x) => {
            if (x.textContent.trim() === want) x.classList.add("ok");
          });
        }
        q.querySelector(".q-why").hidden = false;
        score();
      });
    });
  });

  score();
})();
