<template>
  <main class="research-page">
    <header class="hero">
      <div><p class="eyebrow">LOTTERY LAB · 彩票数据实验</p><h1>先验证，再选号。</h1>
        <p>用公开历史数据检验预测方法，记录每一次候选。</p></div>
      <span class="hero-note">每注 2 元 · 结果可复现</span>
    </header>

    <p v-if="loading" role="status">正在读取数据与训练结果…</p>
    <div v-if="error" class="error" role="alert">{{ error }} <button @click="load">重新读取</button></div>
    <template v-if="report">
      <nav class="lottery-tabs" aria-label="选择彩种">
        <button v-for="(label, kind) in lotteryNames" :key="kind" :class="{ active: type === kind }" @click="switchType(kind)">{{ label }}</button>
      </nav>

      <section class="panel">
        <div class="section-heading"><h2>自动更新</h2><button :disabled="loading" @click="load">刷新状态</button></div>
        <p>{{ report.automation?.configured ? '更新密钥已配置' : '尚未完成自动更新配置' }} · 当前使用{{ report.automation?.source === 'd1' ? '在线模型快照' : '部署时的初始快照' }}</p>
        <p v-if="report.automation?.latest_run">最近任务：{{ runNames[report.automation.latest_run.status] || report.automation.latest_run.status }} · {{ stageNames[report.automation.latest_run.stage] || report.automation.latest_run.stage }} · {{ localTime(report.automation.latest_run.updated_at) }}</p>
        <p v-else class="muted">尚无自动任务记录。完成一次 GitHub Actions 手动运行后，可在此核对状态。</p>
        <p v-if="report.automation?.latest_run?.status === 'failed'" class="error">最近更新失败，请查看 GitHub Actions 日志。服务保留上一版；过期后暂停生成候选。</p>
        <p class="muted">按北京时间每天 22:30、23:30 和次日 07:30 检查。取得新开奖后采集、核对、训练并发布；没有新开奖时保留原快照。GitHub 定时任务可能延迟。</p>
        <p v-if="report.automation?.activated_at" class="muted">当前快照发布于 {{ localTime(report.automation.activated_at) }}。模型 {{ report.model_run_id }}</p>
      </section>

      <section class="panel dataset">
        <div class="section-heading"><h2>数据底座</h2><span>截至 {{ current.coverage.last_date }} · 第 {{ current.coverage.last_issue }} 期</span></div>
        <div class="stats-grid">
          <div><strong>{{ current.coverage.count.toLocaleString() }}</strong><span>历史开奖号码 / 期</span></div>
          <div><strong>{{ current.coverage.prize_count.toLocaleString() }}</strong><span>各奖级记录 / 期</span></div>
          <div><strong>{{ current.coverage.region_count.toLocaleString() }}</strong><span>可解析省级分布 / 期</span></div>
          <div><strong>{{ current.coverage.outlet_count }}</strong><span>已核实中奖网点 / 条</span></div>
        </div>
        <p class="muted">{{ current.coverage.first_date }} 起；官方来源覆盖 {{ current.coverage.official_count }} 期，销量 {{ current.coverage.sales_count }} 期，奖池 {{ current.coverage.pool_count }} 期。缺失字段保留为空。</p>
        <p class="muted">当前范围内期号缺失 {{ current.coverage.missing_issues.length }} 期。双色球早期号码由新浪补齐；具体中奖网点尚未取得可核实样本。</p>
        <p v-if="current.coverage.unverified_zero_pool_count" class="muted">其中 {{ current.coverage.unverified_zero_pool_count }} 期早期奖池为来源返回的0值，同时缺失销量，真实性未核实。保留原值，训练中按缺失处理。</p>
        <details><summary>最近一期官方数据</summary>
          <p>号码 {{ current.latest_draw.red.map(format).join(' ') }} + {{ current.latest_draw.blue.map(format).join(' ') }}</p>
          <p>销量 {{ yuan(current.latest_draw.sales_cents) }} 元 · 开奖后奖池 {{ yuan(current.latest_draw.pool_cents) }} 元</p>
          <p>可核对的省级一等奖分布：{{ current.latest_draw.regions.length ? current.latest_draw.regions.map(r => `${r.region}${r.first_prize_stakes}注`).join('，') : '未取得完整可解析样本' }}。中奖注数不等于中奖人数。</p>
          <table><thead><tr><th>奖级</th><th>中奖注数</th><th>单注奖金 / 元</th></tr></thead><tbody>
            <tr v-for="tier in current.latest_draw.prize_tiers" :key="tier.tier"><td>{{ tier.label }}</td><td>{{ tier.stakes ?? '缺失' }}</td><td>{{ yuan(tier.amount_cents) }}</td></tr>
          </tbody></table>
          <a v-if="current.latest_draw.detail_url" :href="current.latest_draw.detail_url" target="_blank" rel="noopener noreferrer">查看官方公告</a>
        </details>
      </section>

      <section class="panel">
        <div class="section-heading"><h2>训练检验</h2><span>首次划分后固定测试区间</span></div>
        <div class="split-grid"><div v-for="(split, name) in current.split" :key="name"><b>{{ splitNames[name] }} · {{ split.count }} 期</b><span>{{ split.first_date }} — {{ split.last_date }}</span></div></div>
        <p>目前没有证据证明这些模型能提高下一期整注一等奖概率。正式候选采用均匀随机，并在整注层面去重。</p>
        <div class="table-scroll"><table><thead><tr><th>方法</th><th>验证评分</th><th>测试评分</th><th>相对随机差值</th><th>99% 差值区间</th></tr></thead><tbody>
          <tr v-for="(metric, name) in current.metrics" :key="name" :class="{ baseline: name === 'uniform' }"><td>{{ modelNames[name] }}</td><td>{{ fixed(metric.validation.brier) }}</td><td>{{ fixed(metric.test.brier) }}</td><td>{{ signed(metric.test.brier_delta_vs_uniform) }}</td><td>{{ metric.test.delta_99pct_block_bootstrap_ci.map(signed).join(' ～ ') }}</td></tr>
        </tbody></table></div>
        <p class="muted">Brier 评分越低越好，差值为“模型 − 随机”。区间跨过 0，表示未检出稳定差异。这是单号码边际评分，不能当作整注中奖概率。</p>
        <details><summary>训练方法与相同预算检验</summary>
          <p>前 200 期用于特征预热；首次按时间划分 60% 训练、20% 验证、20% 测试。每日更新固定这些区间、频率窗口和正则参数，用新增历史重新拟合下期实验模型；新增表现由下方前瞻记录检验。</p>
          <p>历史特征包括近 20/60/200 期频率、遗漏、前两期是否出现和邻号。扩展模型加入销量、开奖后奖池、一等奖注数与奖金、可核实省级分布集中度及缺失标记，并与号码特征交互。</p>
          <p>元数据至少滞后两期，并设置开奖日期后 48 小时隔离。历史真实发布时间未取得，因此元数据实验仍属于探索性历史重放。</p>
          <table><thead><tr><th>方法</th><th>每期注数 / 元</th><th>测试期数</th><th>命中一等奖期数</th></tr></thead><tbody><tr v-for="(item, name) in current.same_budget_test" :key="name"><td>{{ modelNames[name] }}</td><td>{{ item.tickets_per_draw }} / {{ item.cost_yuan_per_draw }}</td><td>{{ item.draws }}</td><td>{{ item.jackpot_draws }}</td></tr></tbody></table>
          <p class="muted">使用固定种子重复实验；样本不足以评估极低概率的一等奖优势。{{ current.rule_notice }}</p>
        </details>
      </section>

      <section class="panel">
        <div class="section-heading"><h2>上线后前瞻检验</h2><span>先发布，再开奖核对</span></div>
        <template v-if="prospective">
          <p>已核对 {{ prospective.draws }} 个不同开奖期，最近至 {{ prospective.last_issue }} 期。</p>
          <div class="table-scroll"><table><thead><tr><th>实验模型</th><th>平均 Brier 相对随机差值</th></tr></thead><tbody>
            <tr><td>历史频率</td><td>{{ signed(prospective.frequency_delta) }}</td></tr>
            <tr><td>历史特征</td><td>{{ signed(prospective.history_delta) }}</td></tr>
            <tr><td>历史 + 周边信息</td><td>{{ signed(prospective.metadata_delta) }}</td></tr>
          </tbody></table></div>
          <p class="muted">只统计开奖前首次发布的快照，每期一次。负数表示边际评分较低，少量样本不能说明稳定优势，也不等于整注一等奖概率提升。</p>
        </template>
        <p v-else class="muted">尚无可核对的前瞻样本。首次发布后，等待对应日期的官方开奖；不会用历史回测填充这里。</p>
      </section>

      <section class="panel candidates">
        <div class="section-heading"><h2>下期候选</h2><span>日期估计 {{ current.target_date_estimate }} · 期号待官方确认</span></div>
        <p v-if="current.status.stale" class="error">数据快照已过生成截止时间，等待自动更新。若持续未更新，请检查任务状态。下方保留的是当时生成的历史候选。</p>
        <div class="controls">
          <label>生成方法<select v-model="model"><option v-for="(label, name) in modelNames" :key="name" :value="name">{{ label }}{{ name === 'uniform' ? '（默认）' : '（实验）' }}</option></select></label>
          <label>注数<input v-model.number="count" type="number" min="1" max="20" step="1" /></label>
          <button class="primary" :disabled="generating || current.status.stale" @click="generate">{{ generating ? '生成中…' : '生成新候选' }}</button>
        </div>
        <p v-if="generationError" role="alert" class="error">{{ generationError }}</p>
        <template v-if="candidate">
          <div class="budget"><b>{{ candidate.plans.length }} 注 · {{ candidate.cost_yuan }} 元</b><span>公平开奖下，一等奖覆盖 {{ candidate.plans.length }}/{{ current.combination_count.toLocaleString() }}</span></div>
          <p class="muted">{{ candidate.notice || current.production_policy.reason }}</p>
          <ol class="ticket-list"><li v-for="(plan, index) in candidate.plans" :key="index"><span class="ticket-index">{{ String(index + 1).padStart(2, '0') }}</span><span v-for="number in plan.red" :key="'r'+number" class="ball">{{ number }}</span><span class="plus">+</span><span v-for="number in plan.blue" :key="'b'+number" class="ball blue">{{ number }}</span></li></ol>
          <div class="candidate-footer"><span>模型 {{ modelNames[candidate.model] }} · 种子 {{ candidate.seed }}</span><button @click="download">下载本次记录</button></div>
          <p class="muted">{{ candidate.storage_notice || '训练时生成的候选已保存在本地实验记录中。' }} 生成或下载不表示已购票；开奖安排以官方公告为准。</p>
        </template>
      </section>
      <section class="panel">
        <div class="section-heading"><h2>我的候选核对</h2><span>当前浏览器最近 20 次</span></div>
        <p v-if="historyError" class="error">{{ historyError }}</p>
        <p v-if="!visibleHistory.length" class="muted">在本页生成并保存到数据库的候选，将在对应日期开奖后自动核对。记录ID保存在当前浏览器，换设备不会自动同步。</p>
        <details v-for="item in visibleHistory" :key="item.run_id">
          <summary>{{ localTime(item.created_at) }} · {{ item.plans.length }} 注 · {{ item.result ? '已核对第 ' + item.result.issue + ' 期' : '待核对（目标日期估计 ' + item.target_date_estimate + '）' }}</summary>
          <p v-for="(plan, index) in item.plans" :key="index">{{ plan.red.join(' ') }} + {{ plan.blue.join(' ') }}<template v-if="item.result"> · 命中 {{ item.result.hits[index].red_hits }} + {{ item.result.hits[index].blue_hits }}{{ item.result.hits[index].jackpot ? ' · 一等奖号码全中' : '' }}</template></p>
          <p class="muted">{{ item.result ? '仅核对命中个数；未计算奖金，不表示实际购票。' : '日期延期或休市时保留待核对，不擅自匹配其他期次。' }}</p>
        </details>
      </section>
      <footer class="footer"><details><summary>数据限制与实验版本</summary><p v-for="notice in report.limitations" :key="notice">{{ notice }}</p><p>训练版本 {{ report.version }} · {{ report.model_run_id }}</p><p class="fingerprint">数据指纹 {{ report.dataset_sha256 }}</p><p>训练在 GitHub Actions 后台执行，网页读取已经发布的快照；浏览或生成号码不会触发训练。</p></details></footer>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
const lotteryNames = { ssq: '双色球', dlt: '大乐透' };
const modelNames = { uniform: '均匀随机', frequency: '历史频率', history_logistic: '历史特征模型', metadata_logistic: '历史 + 周边信息模型' };
const splitNames = { train: '训练', validation: '验证', test: '留出测试' };
const runNames = { running: '运行中', failed: '失败', no_change: '暂无新开奖', succeeded: '成功' };
const stageNames = { setup: '初始化', collect: '采集', settle: '开奖核对', train: '训练', publish: '发布', complete: '完成' };
const report = ref(null), loading = ref(false), error = ref(''), type = ref('ssq');
const model = ref('uniform'), count = ref(5), candidate = ref(null), generating = ref(false), generationError = ref('');
const history = ref([]), historyError = ref('');
const current = computed(() => report.value?.lotteries[type.value]);
const prospective = computed(() => report.value?.automation?.prospective?.find(p => p.lottery_type === type.value));
const visibleHistory = computed(() => history.value.filter(item => item.lottery_type === type.value));
const format = n => String(n).padStart(2, '0');
const fixed = n => n.toFixed(8);
const signed = n => (n >= 0 ? '+' : '') + n.toFixed(8);
const yuan = cents => cents == null ? '缺失' : (cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const localTime = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function savedIds() { try { const ids = JSON.parse(localStorage.getItem('research_run_ids') || '[]'); return Array.isArray(ids) ? ids.slice(0, 20) : []; } catch { return []; } }
async function loadHistory() {
  historyError.value = '';
  try { const ids = savedIds(); history.value = ids.length ? (await api.researchResults(ids)).data.data : []; }
  catch { historyError.value = '暂时无法读取候选核对记录，稍后点击刷新状态重试。'; }
}
function switchType(kind) { type.value = kind; model.value = 'uniform'; generationError.value = ''; candidate.value = current.value.candidate_run; }
async function load() {
  loading.value = true; error.value = '';
  try { const result = await api.research(); report.value = result.data.data; candidate.value = current.value.candidate_run; await loadHistory(); }
  catch (e) { error.value = e.response?.data?.error || '无法读取研究数据，请确认本地 API 已启动。'; }
  finally { loading.value = false; }
}
async function generate() {
  if (!Number.isInteger(count.value) || count.value < 1 || count.value > 20) { generationError.value = '注数须为1—20的整数'; return; }
  generating.value = true; generationError.value = '';
  const requestedType = type.value;
  try {
    const result = await api.predictBundle({ lotteryType: requestedType, model: model.value, count: count.value });
    if (type.value === requestedType) candidate.value = result.data.data;
    if (result.data.data.saved) {
      try { localStorage.setItem('research_run_ids', JSON.stringify([result.data.data.run_id, ...savedIds()].slice(0, 20))); }
      catch { generationError.value = '已保存到服务，但浏览器无法记住记录ID；请下载本次记录。'; }
      await loadHistory();
    }
  } catch (e) { generationError.value = e.response?.data?.error || '生成失败，请稍后重试'; }
  finally { generating.value = false; }
}
function download() {
  const blob = new Blob([JSON.stringify(candidate.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${type.value}-${candidate.value.run_id}.json`; anchor.click(); URL.revokeObjectURL(url);
}
onMounted(load);
</script>

<style scoped>
.research-page{max-width:1080px;margin:auto;padding:44px 24px 60px;color:#213333;font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;line-height:1.65}.hero{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}.eyebrow{font-size:12px;letter-spacing:2px;color:#407c72;margin:0}h1{font-size:42px;letter-spacing:-1px;line-height:1.25;margin:12px 0}h2{font-size:20px;margin:0}.hero p:last-child{color:#697b78;margin:0}.hero-note{padding:8px 14px;background:#e8f1ed;border-radius:30px;font-size:12px;white-space:nowrap}.lottery-tabs{display:flex;gap:8px;margin-bottom:22px}button,select,input{font:inherit}button{cursor:pointer;border:1px solid #d9e2df;border-radius:8px;background:white;color:#334d47;padding:9px 17px}button:hover{border-color:#477e71}button:disabled{opacity:.45;cursor:default}.lottery-tabs .active,.primary{background:#245a4e;color:white;border-color:#245a4e}.panel{background:white;border:1px solid #e1e8e5;border-radius:16px;padding:26px;margin-bottom:22px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:22px}.section-heading>span,.muted{font-size:13px;color:#657b75}.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin:24px 0}.stats-grid strong{font-size:32px;line-height:1.3;display:block;letter-spacing:-1px}.stats-grid span{font-size:12px;color:#70837e}.split-grid{display:grid;grid-template-columns:repeat(3,1fr);background:#f3f7f5;border-radius:10px;padding:16px;gap:14px;font-size:13px}.split-grid span{display:block;font-size:12px;color:#70837e;margin-top:4px}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:12px;white-space:nowrap}th,td{padding:12px 10px;border-bottom:1px solid #e8eeeb}th{font-weight:500;color:#6d7d78}.baseline{background:#f2f7f3}.controls{display:flex;gap:18px;align-items:end;flex-wrap:wrap}.controls label{font-size:12px;color:#647971;display:flex;flex-direction:column;gap:6px}.controls select,.controls input{border:1px solid #dbe4df;padding:10px;border-radius:8px;background:white;color:#223c32}.controls input{width:70px}.budget{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:24px}.budget span{font-size:13px;color:#60776d}.ticket-list{padding:0;list-style:none;margin:18px 0}.ticket-list li{display:flex;align-items:center;gap:10px;padding:15px 0;border-bottom:1px solid #edf1ef}.ticket-index{font-size:12px;color:#8b9a94;margin-right:14px}.ball{background:#fff1ee;color:#ba5341;width:38px;height:38px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:17px;font-weight:600}.ball.blue{background:#ecf3fd;color:#3a70a7}.plus{color:#92a39c;margin:0 5px}.candidate-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;color:#6d7f77}details{margin-top:18px;font-size:13px}summary{cursor:pointer;color:#326659}details p{color:#60746b}.error{padding:12px;background:#fff1ec;color:#a24027;border-radius:8px}.footer{padding:0 10px;color:#73877d;font-size:12px}.fingerprint{overflow-wrap:anywhere}a{color:#326659}@media(max-width:650px){.research-page{padding:26px 14px 40px}.hero-note{display:none}h1{font-size:34px}.panel{padding:20px 15px}.section-heading{display:block}.section-heading>span{display:block;margin-top:6px}.stats-grid{grid-template-columns:repeat(2,1fr)}.split-grid{grid-template-columns:1fr}.ticket-list li{gap:5px}.ball{width:30px;height:30px;font-size:14px}.ticket-index{margin-right:4px}.plus{margin:0 2px}.candidate-footer{flex-wrap:wrap}}
</style>
