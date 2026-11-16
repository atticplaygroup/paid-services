import { getDailyBudget } from '../../applications/papp-sdk/src/browser.ts';
getDailyBudget().then(budget => {
  document.querySelector('#daily-budget')!.textContent = budget.dailyBudget;
  document.querySelector('#probe-ready')!.textContent = 'ready';
}).catch(error => { document.querySelector('#probe-ready')!.textContent = error.message });
