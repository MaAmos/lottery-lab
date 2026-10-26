<template>
  <div class="container">
    <!-- <GoogleAd client="ca-pub-6214228377221315" slotId="5428596580" /> -->
    <!-- Header -->
    <div class="page-header">
      <h1 class="title">AI彩票预测助手</h1>
      <p class="subtitle">基于大数据与AI算法分析，结果仅供参考娱乐</p>
    </div>

    <!-- History Section -->
    <div class="section-card">
      <div class="section-title">
        <div class="section-title-left">
          <div class="section-title-text">往期预测回顾</div>
          <div class="section-subtitle">最近5期预测命中情况</div>
        </div>
        <button class="view-all-btn" @click="$router.push('/history')">
          查看全部
        </button>
      </div>

      <div class="history-list" v-if="historyList.length > 0">
        <div
          class="history-item"
          :class="{
            'hit-item': item.hit_count > 0,
            'miss-item':
              item.hit_count === 0 && item.red_lottery_nums.length > 0,
          }"
          v-for="(item, index) in historyList"
          :key="index"
        >
          <div class="history-header">
            <div class="issue-info">
              {{ item.lottery_type === "ssq" ? "双色球" : "大乐透" }}
              <span v-if="getCompoundLabel(item)" class="compound-tag">
                {{ getCompoundLabel(item) }}
              </span>
              <span v-if="getCompoundLabel(item)" class="compound-info">
                ({{ item.red_predicted_nums.length }}+{{
                  item.blue_predicted_nums.length
                }})
              </span>
              <span v-if="item.issue">- 第{{ item.issue }}期</span>
              <span v-else>(待开奖)</span>
            </div>
            <div
              class="result-tag"
              :class="item.hit_count > 0 ? 'hit-tag' : 'miss-tag'"
              v-if="item.red_lottery_nums.length > 0"
            >
              {{ item.hit_count > 0 ? `命中${item.hit_count}个` : "未中奖" }}
            </div>
            <div
              class="result-tag miss-tag"
              v-else
              style="background: #e0e0e0; color: #666"
            >
              等待开奖
            </div>
          </div>

          <div class="numbers-comparison">
            <div class="numbers-group">
              <div class="numbers-label">预测号码</div>
              <div class="numbers-display">
                <!-- 红球预测 -->
                <span
                  v-for="num in item.red_predicted_nums"
                  :key="'p-r-' + num"
                  class="number-ball predicted"
                  :class="{
                    'hit-ball':
                      item.red_lottery_nums &&
                      item.red_lottery_nums.includes(num),
                  }"
                >
                  {{ num }}
                  <div
                    class="hit-indicator"
                    v-if="
                      item.red_lottery_nums &&
                      item.red_lottery_nums.includes(num)
                    "
                  >
                    ✓
                  </div>
                </span>
                <!-- 蓝球预测 -->
                <span
                  v-for="num in item.blue_predicted_nums"
                  :key="'p-b-' + num"
                  class="number-ball predicted blue-predicted"
                  :class="{
                    'hit-ball':
                      item.blue_lottery_nums &&
                      item.blue_lottery_nums.includes(num),
                  }"
                  style="
                    color: #1976d2;
                    border-color: #bbdefb;
                    background: #e3f2fd;
                  "
                >
                  {{ num }}
                  <div
                    class="hit-indicator"
                    v-if="
                      item.blue_lottery_nums &&
                      item.blue_lottery_nums.includes(num)
                    "
                  >
                    ✓
                  </div>
                </span>
              </div>
            </div>

            <div class="vs-text" v-if="item.red_lottery_nums.length > 0">
              VS
            </div>

            <div class="numbers-group" v-if="item.red_lottery_nums.length > 0">
              <div class="numbers-label">开奖号码</div>
              <div class="numbers-display">
                <span
                  v-for="num in item.red_lottery_nums"
                  :key="'l-r-' + num"
                  class="number-ball lottery"
                  style="
                    color: #c62828;
                    background: #ffebee;
                    border-color: #ffcdd2;
                  "
                  >{{ num }}</span
                >
                <span
                  v-for="num in item.blue_lottery_nums"
                  :key="'l-b-' + num"
                  class="number-ball lottery"
                  style="
                    color: #1565c0;
                    background: #e3f2fd;
                    border-color: #90caf9;
                  "
                  >{{ num }}</span
                >
              </div>
            </div>
            <div class="numbers-group" v-else>
              <div class="numbers-label">开奖号码</div>
              <div
                class="numbers-display"
                style="color: #999; font-size: 14px; padding-top: 10px"
              >
                待开奖
              </div>
            </div>
          </div>

          <div class="history-footer">
            <span>{{ new Date(item.create_time).toLocaleString() }}</span>
            <span
              class="prize-info"
              v-if="item.prize_level"
              style="color: #ff9800; font-weight: bold"
            >
              {{ item.prize_level }}
            </span>
          </div>
        </div>
      </div>
      <van-empty v-else description="暂无历史记录" />
    </div>

    <!-- AI Prediction Section -->
    <div class="section-card">
      <div class="section-title">
        <div class="section-title-text">AI智能预测</div>
        <div class="section-subtitle">基于历史数据与AI算法分析</div>
      </div>

      <div class="prediction-section">
        <div class="lottery-type-selector">
          <div
            class="type-btn"
            :class="{ active: selectedType === 'ssq' }"
            @click="selectedType = 'ssq'"
          >
            <img
              src="../assets/images/Icon-cz64-1.png"
              class="type-icon"
              alt="SSQ"
            />
            <div class="type-name">双色球</div>
          </div>

          <div
            class="type-btn"
            :class="{ active: selectedType === 'dlt' }"
            @click="selectedType = 'dlt'"
          >
            <img
              src="../assets/images/Icon-cz64-2.png"
              class="type-icon"
              alt="DLT"
            />
            <div class="type-name">大乐透</div>
          </div>
        </div>

        <!-- Mode Tabs -->
        <div class="options-container mode-selection">
          <div class="mode-tabs">
            <div
              v-for="mode in availableModes"
              :key="mode.cost"
              class="mode-chip"
              :class="{ active: selectedModeCost === mode.cost }"
              @click="selectedModeCost = mode.cost"
            >
              <div class="chip-content">
                <span class="chip-label">{{ mode.label }}</span>
                <span class="chip-cost">{{ mode.sub }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Result Display -->
        <div class="prediction-result" v-if="predictionResult">
          <template v-if="currentDisplayData">
            <div class="result-header">
              <div class="result-title">
                {{ currentDisplayData.type || "AI预测结果" }}
              </div>
              <div class="result-subtitle">
                {{ currentDisplayData.desc || "基于AI智能算法生成" }}
              </div>
            </div>

            <div class="prediction-numbers">
              <div class="prediction-numbers-display">
                <span
                  v-for="n in currentDisplayData.red"
                  :key="'r-' + n"
                  class="prediction-number-ball red-ball"
                  :class="{ 'small-ball': selectedModeCost > 2 }"
                  >{{ n }}</span
                >
                <span
                  v-for="n in currentDisplayData.blue"
                  :key="'b-' + n"
                  class="prediction-number-ball blue-ball"
                  :class="{ 'small-ball': selectedModeCost > 2 }"
                  >{{ n }}</span
                >
              </div>
            </div>

            <div class="result-footer-tag">
              <span class="tag-icon">💰</span> 预估成本:
              {{ currentDisplayData.cost }}元
            </div>

            <div
              class="result-footer-tag"
              v-if="currentDisplayData.confidence !== undefined"
            >
              <span class="tag-icon">🎯</span> 策略信心:
              {{ currentDisplayData.confidence }}%
            </div>

            <div
              class="result-footer-tag"
              v-if="currentDisplayData.strategyLabel"
            >
              <span class="tag-icon">🧠</span> 采用策略:
              {{ currentDisplayData.strategyLabel }}
            </div>
          </template>

          <div v-else class="empty-mode-state">
            <p>当前模式暂无推荐结果</p>
            <p class="sub-empty">请尝试重新生成或切换其他模式</p>
          </div>
        </div>

        <!-- Buttons -->
        <div class="prediction-actions">
          <button
            class="predict-btn"
            :class="{ predicting: loading }"
            id="predictBtn"
            :disabled="operationLoading"
            @click="startPredict"
          >
            <span id="predictBtnContent">
              <span>{{ loading ? "生成中..." : "开始生成" }}</span>
            </span>
          </button>

          <button
            v-if="predictionResult"
            class="clear-btn"
            id="clearBtn"
            @click="clearPrediction"
          >
            清空结果
          </button>
        </div>

        <div class="advanced-actions">
          <button
            class="secondary-action-btn"
            :disabled="operationLoading"
            @click="startBundlePredict"
          >
            {{ bundleLoading ? "生成中..." : "生成5组分散方案" }}
          </button>
          <button
            class="secondary-action-btn"
            :disabled="operationLoading"
            @click="runBacktest"
          >
            {{ backtestLoading ? "回测中..." : "回测策略表现" }}
          </button>
        </div>

        <div class="bundle-result" v-if="bundleResult && bundleResult.plans.length">
          <div class="mini-section-title">分散方案</div>
          <div class="backtest-summary" v-if="bundleResult.strategy_plan_summary">
            {{
              bundleResult.strategy_source === "backtest_adaptive"
                ? "已按回测表现动态分配："
                : "使用默认分散策略："
            }}{{ bundleResult.strategy_plan_summary }}
          </div>
          <div
            class="bundle-item"
            v-for="(plan, index) in bundleResult.plans"
            :key="'bundle-' + index"
          >
            <div class="bundle-header">
              <span>第{{ index + 1 }}组</span>
              <span>{{ plan.strategy_label }} · {{ plan.confidence }}%</span>
            </div>
            <div class="prediction-numbers-display compact-numbers">
              <span
                v-for="n in plan.prediction.red"
                :key="'bundle-r-' + index + '-' + n"
                class="prediction-number-ball red-ball small-ball"
                >{{ n }}</span
              >
              <span
                v-for="n in plan.prediction.blue"
                :key="'bundle-b-' + index + '-' + n"
                class="prediction-number-ball blue-ball small-ball"
                >{{ n }}</span
              >
            </div>
          </div>
        </div>

        <div class="backtest-result" v-if="backtestResult">
          <div class="mini-section-title">回测评分</div>
          <div class="backtest-summary" v-if="backtestResult.notice">
            {{ backtestResult.notice }}
          </div>
          <div class="backtest-summary" v-if="backtestResult.recommended">
            推荐：{{ backtestResult.recommended.label }}，最近{{
              backtestResult.rounds
            }}期平均命中{{ backtestResult.recommended.avgTotalHits }}个
          </div>
          <div
            class="strategy-row"
            v-for="item in backtestResult.strategies"
            :key="'bt-' + item.algorithm"
          >
            <span>{{ item.label }}</span>
            <span>
              红{{ item.avgRedHits }} 蓝{{ item.avgBlueHits }} · 小奖{{
                item.prizeHitRate
              }}%
            </span>
          </div>
        </div>

        <!-- Disclaimer -->
        <div class="disclaimer">
          <p class="disclaimer-title">重要声明</p>
          <p class="disclaimer-content">
            1.
            本程序所有预测结果基于历史数据与AI算法分析生成，仅供参考娱乐，不构成任何投资建议。<br />
            2. 彩票中奖为独立随机事件，AI预测无法保证中奖，请理性购彩。<br />
            3. 预测结果不具任何法律效力，购彩风险请自行承担。
          </p>
        </div>
      </div>
    </div>
    <!-- Lucky Numbers Section -->
    <!-- <div class="section-card">
      <div class="section-title">
        <div class="section-title-text">今日幸运号码</div>
        <div class="section-subtitle">基于今日运势与相关算法分析</div>
      </div>
      <div class="lucky-section">
        <div class="lucky-info">
          <div class="lucky-numbers">
            <div class="lucky-label">您的专属幸运号</div>
            <div class="lucky-numbers-display" id="lucky-numbers-container">
              <span
                v-for="item in luckyNumbers"
                :key="item.number"
                class="lucky-number-ball"
                :class="item.type === 'red' ? 'red-ball' : 'blue-ball'"
              >
                {{ item.number }}
                <div class="lucky-star">✨</div>
              </span>
            </div>
            <div class="lucky-tip">这些数字今天与您特别有缘</div>
          </div>
        </div>

        <div class="lucky-actions">
          <button class="refresh-btn" @click="generateLucky">
            <img
              src="../assets/images/refresh.png"
              class="btn-icon"
              alt="Refresh"
            />
            换一组
          </button>
        </div>
      </div>
    </div> -->
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { showToast, showSuccessToast } from "vant";
import { api } from "../api";
// Data
const selectedType = ref("ssq");
const selectedModeCost = ref(2);
const loading = ref(false);
const bundleLoading = ref(false);
const backtestLoading = ref(false);
const predictionResult = ref(null);
const bundleResult = ref(null);
const backtestResult = ref(null);
const historyList = ref([]);
const luckyNumbers = ref([]);

const operationLoading = computed(
  () => loading.value || bundleLoading.value || backtestLoading.value,
);

const getApiError = (error, fallback) => {
  if (error?.response?.data?.error) return error.response.data.error;
  if (error?.code === "ECONNABORTED") return "请求超时，请稍后重试";
  return fallback;
};

// Computed & Watch
const availableModes = computed(() => {
  if (selectedType.value === "ssq") {
    return [
      { cost: 2, label: "单式", sub: "2元" },
      { cost: 10, label: "复式", sub: "10元" },
      { cost: 14, label: "复式", sub: "14元" },
    ];
  } else {
    return [
      { cost: 2, label: "单式", sub: "2元" },
      { cost: 6, label: "复式", sub: "6元" },
      { cost: 12, label: "复式", sub: "12元" },
    ];
  }
});

watch(selectedType, () => {
  selectedModeCost.value = 2; // Reset on type change
  predictionResult.value = null; // Reset result on type change
  bundleResult.value = null;
  backtestResult.value = null;
});

const currentDisplayData = computed(() => {
  if (!predictionResult.value) return null;

  if (selectedModeCost.value === 2) {
    return {
      type: "单式精选",
      desc: "基于AI智能算法生成",
      red: predictionResult.value.prediction.red,
      blue: predictionResult.value.prediction.blue,
      cost: 2,
      confidence: predictionResult.value.confidence,
      strategyLabel: predictionResult.value.strategy_label,
    };
  }

  // Find compound
  if (predictionResult.value.compounds) {
    const found = predictionResult.value.compounds.find(
      (c) => c.cost === selectedModeCost.value,
    );
    if (found) {
      return {
        type: found.type,
        desc: found.desc,
        red: found.red,
        blue: found.blue,
        cost: found.cost,
        confidence: predictionResult.value.confidence,
        strategyLabel: predictionResult.value.strategy_label,
      };
    }
  }
  return null;
});

// 1. Initial Load
onMounted(() => {
  generateLucky();
  loadHistory();
});

// 2. Load History
const loadHistory = async () => {
  try {
    const res = await api.getHistory({ limit: 10 });
    if (res.data.success) {
      historyList.value = res.data.data.history.data;
    }
  } catch (e) {
    console.error(e);
  }
};

// 3. AI Predict
const startPredict = async () => {
  if (operationLoading.value) return;
  loading.value = true;
  try {
    const res = await api.predict({
      lotteryType: selectedType.value,
      cost: selectedModeCost.value,
      algorithm: "ensemble",
    });
    if (res.data.success) {
      predictionResult.value = res.data.data;
      if (res.data.data.saved) {
        void loadHistory();
      } else if (res.data.data.save_attempted) {
        showToast(res.data.data.save_error || "号码已生成，但保存历史失败");
      } else {
        savePrediction();
      }
    } else {
      showToast(res.data.error || "生成失败");
    }
  } catch (e) {
    showToast(getApiError(e, "生成失败，请稍后重试"));
  } finally {
    loading.value = false;
  }
};

// 清空结果
const clearPrediction = () => {
  predictionResult.value = null;
  bundleResult.value = null;
};

const startBundlePredict = async () => {
  if (operationLoading.value) return;
  bundleLoading.value = true;
  try {
    const res = await api.predictBundle({
      lotteryType: selectedType.value,
      count: 5,
      algorithm: "ensemble",
    });
    if (res.data.success) {
      bundleResult.value = res.data.data;
      if (res.data.data.saved) {
        void loadHistory();
      } else if (res.data.data.save_attempted) {
        showToast(res.data.data.save_error || "方案已生成，但保存历史失败");
      }
    } else {
      showToast(res.data.error || "生成多组方案失败");
    }
  } catch (e) {
    showToast(getApiError(e, "生成多组方案失败，请稍后重试"));
  } finally {
    bundleLoading.value = false;
  }
};

const runBacktest = async () => {
  if (operationLoading.value) return;
  backtestLoading.value = true;
  try {
    const res = await api.backtest({
      lotteryType: selectedType.value,
      rounds: 20,
    });
    if (res.data.success) {
      backtestResult.value = res.data.data;
    } else {
      showToast(res.data.error || "回测失败");
    }
  } catch (e) {
    showToast(getApiError(e, "回测失败，请稍后重试"));
  } finally {
    backtestLoading.value = false;
  }
};

// 4. Save
const savePrediction = async () => {
  if (!currentDisplayData.value) return;
  try {
    const payload = {
      lottery_type: selectedType.value,
      red_predicted_nums: currentDisplayData.value.red, // Use generated compound data if any
      blue_predicted_nums: currentDisplayData.value.blue,
    };
    const res = await api.savePrediction(payload);
    if (res.data.success) {
      // Saved silently, or refresh history
      loadHistory();
    }
  } catch (e) {
    // showToast("保存失败");
  }
};

// 5. Local Lucky Numbers
const generateUnique = (max, count) => {
  const nums = new Set();
  while (nums.size < count) {
    nums.add(Math.floor(Math.random() * max) + 1);
  }
  return Array.from(nums)
    .sort((a, b) => a - b)
    .map((n) => n.toString().padStart(2, "0"));
};

const generateLucky = () => {
  const reds = generateUnique(33, 3);
  const blues = generateUnique(16, 1);

  luckyNumbers.value = [
    ...reds.map((n) => ({ number: n, type: "red" })),
    ...blues.map((n) => ({ number: n, type: "blue" })),
  ];
};

const formatDate = (ts) => {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString();
};

const getCompoundLabel = (item) => {
  if (!item.red_predicted_nums || !item.blue_predicted_nums) return "";
  const rt = item.lottery_type;
  const r = item.red_predicted_nums.length;
  const b = item.blue_predicted_nums.length;

  if (rt === "ssq") {
    // Standard: 6+1
    if (r === 6 && b === 1) return "";
    // Compound 10: 6+5 (10元)
    if (r === 6 && b === 5) return "10元复式";
    // Compound 14: 7+1 (14元)
    if (r === 7 && b === 1) return "14元复式";
    // Other
    if (r > 6 || b > 1) return "复式投注";
  } else {
    // DLT
    // Standard: 5+2
    if (r === 5 && b === 2) return "";
    // Compound 12: 6+2 (12元)
    if (r === 6 && b === 2) return "12元复式";
    // Compound 6: 5+3 (6元)
    if (r === 5 && b === 3) return "6元复式";
    // Other
    if (r > 5 || b > 2) return "复式投注";
  }
  return "";
};
</script>

<style>
/* Global & Reset */
* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

body {
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, sans-serif;
  margin: 0;
  padding: 0;
  background: #f6f6f6;
  min-height: 100vh;
  color: #333;
}
p,
h1,
h2,
h3,
h4,
h5,
h6 {
  margin: 0;
  padding: 0;
}

button {
  border: none;
  outline: none;
  background: initial;
  padding: 0;
  font-size: inherit;
}
.van-empty {
  max-height: 160px;
  overflow-y: scroll;
  padding: 0 !important;
}
.van-empty__description {
  margin-top: 10px !important;
}
.van-empty__image {
  width: 80px !important;
  height: 80px !important;
}
/* App.wxss Equivalent */
.container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: linear-gradient(180deg, #f5f7fa 0%, #e4e8f0 100%);
  padding: 10px !important;
  padding-bottom: 20px;
  box-sizing: border-box;
}

/* Index.wxss Converted (rpx -> px / 2) */
.page-header {
  text-align: center;
  padding: 20px 0 15px;
}

.title {
  font-size: 24px;
  font-weight: bold;
  color: #1a237e;
  margin-bottom: 5px;
  margin: 0;
}

.subtitle {
  font-size: 13px;
  color: #666;
}

/* Section Card */
.section-card {
  background: white;
  border-radius: 10px;
  padding: 15px;
  margin-bottom: 15px;
  box-shadow: 0 4px 15px rgba(26, 35, 126, 0.08);
  position: relative;
  overflow: hidden;
  width: 100%;
}

.section-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 5px;
  height: 100%;
  background: linear-gradient(180deg, #1a237e 0%, #3949ab 100%);
}

.section-title {
  margin-bottom: 15px;
  padding-bottom: 10px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-title-left {
  display: flex;
  flex-direction: column;
}

.view-all-btn {
  font-size: 13px;
  color: #666;
  background: #f5f5f5;
  padding: 6px 12px;
  border-radius: 15px;
  cursor: pointer;
}

.section-title-text {
  font-size: 18px;
  font-weight: bold;
  color: #333;
  margin-bottom: 4px;
}

.section-subtitle {
  font-size: 13px;
  color: #666;
}

/* History List */
.history-list {
  display: flex;
  flex-direction: column;
  gap: 12.5px;
  max-height: 200px;
  overflow-y: scroll;
}

.history-item {
  border-radius: 8px;
  padding: 12.5px;
  transition: all 0.3s ease;
  background: white;
  border: 1px solid #f0f0f0;
}

.hit-item {
  background: linear-gradient(
    135deg,
    rgba(76, 175, 80, 0.1) 0%,
    rgba(76, 175, 80, 0.05) 100%
  );
  border: 1px solid rgba(76, 175, 80, 0.3);
}

.miss-item {
  background: linear-gradient(
    135deg,
    rgba(244, 67, 54, 0.05) 0%,
    rgba(244, 67, 54, 0.02) 100%
  );
  border: 1px solid rgba(244, 67, 54, 0.2);
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12.5px;
}

.issue-info {
  font-size: 15px;
  font-weight: bold;
  color: #333;
}

.result-tag {
  padding: 4px 10px;
  border-radius: 15px;
  font-size: 12px;
  font-weight: bold;
}

.hit-tag {
  background: #4caf50;
  color: white;
}

.miss-tag {
  background: #f44336;
  color: white;
}

.numbers-comparison {
  display: flex;
  align-items: center;
  gap: 15px;
  margin-bottom: 12.5px;
}

.numbers-group {
  flex: 1;
}

.numbers-label {
  font-size: 12px;
  color: #666;
  margin-bottom: 7.5px;
  text-align: center;
}

.numbers-display {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

.number-ball {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 12px;
  position: relative;
  background: #f5f5f5;
  color: #666;
}

.predicted {
  background: #ffebee;
  color: #c62828;
  border: 1px solid #ffcdd2;
}

.predicted.blue-predicted {
  background: #e3f2fd;
  color: #1976d2;
  border: 1px solid #bbdefb;
}

.lottery {
  background: #ffebee;
  color: #c62828;
  border: 1px solid #ffcdd2;
}

.hit-ball {
  background: #c8e6c9 !important;
  color: #2e7d32 !important;
  border: 1px solid #a5d6a7 !important;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
  }
}

.hit-indicator {
  position: absolute;
  top: -5px;
  right: -5px;
  background: #4caf50;
  color: white;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  font-size: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vs-text {
  font-size: 14px;
  font-weight: bold;
  color: #9c27b0;
  background: #f3e5f5;
  padding: 4px 8px;
  border-radius: 12px;
}

.history-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: #888;
  border-top: 1px dashed #eee;
  padding-top: 8px;
}

.prize-info {
  color: #ff9800;
  font-weight: bold;
}

.history-item {
  border-radius: 8px;
  padding: 12.5px;
  transition: all 0.3s ease;
}

.hit-item {
  background: linear-gradient(
    135deg,
    rgba(76, 175, 80, 0.1) 0%,
    rgba(76, 175, 80, 0.05) 100%
  );
  border: 1px solid rgba(76, 175, 80, 0.3);
}

.miss-item {
  background: linear-gradient(
    135deg,
    rgba(244, 67, 54, 0.05) 0%,
    rgba(244, 67, 54, 0.02) 100%
  );
  border: 1px solid rgba(244, 67, 54, 0.2);
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12.5px;
}

.issue-info {
  font-size: 15px;
  font-weight: bold;
  color: #333;
}

.result-tag {
  padding: 4px 10px;
  border-radius: 15px;
  font-size: 12px;
  font-weight: bold;
}

.hit-tag {
  background: #4caf50;
  color: white;
}

.miss-tag {
  background: #f44336;
  color: white;
}

.numbers-comparison {
  display: flex;
  align-items: center;
  gap: 15px;
  margin-bottom: 12.5px;
}

.numbers-group {
  flex: 1;
}

.numbers-label {
  font-size: 12px;
  color: #666;
  margin-bottom: 7.5px;
  text-align: center;
}

.numbers-display {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}

.number-ball {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 12px;
  position: relative;
}

.predicted {
  background: #e3f2fd;
  color: #1976d2;
  border: 1px solid #bbdefb;
}

.hit-ball {
  background: #c8e6c9;
  color: #2e7d32;
  border: 1px solid #a5d6a7;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
  }
}

.lottery {
  background: #ffebee;
  color: #c62828;
  border: 1px solid #ffcdd2;
}

.hit-indicator {
  position: absolute;
  top: -5px;
  right: -4px;
  background: #4caf50;
  color: white;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  font-size: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vs-text {
  font-size: 14px;
  font-weight: bold;
  color: #9c27b0;
  background: #f3e5f5;
  padding: 5px 10px;
  border-radius: 15px;
}

.history-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: #888;
}

.prize-info {
  color: #ff9800;
  font-weight: bold;
}

.no-data {
  text-align: center;
  padding: 30px 0;
}

.no-data-img {
  width: 100px;
  height: 100px;
  margin-bottom: 15px;
  opacity: 0.6;
  object-fit: contain;
}

.no-data-text {
  font-size: 14px;
  color: #999;
}

/* Lucky Numbers Section */
.lucky-section {
  padding: 10px 0;
}

.lucky-numbers {
  text-align: center;
  margin-bottom: 20px;
}

.lucky-label {
  font-size: 14px;
  color: #666;
  margin-bottom: 12.5px;
}

.lucky-numbers-display {
  display: flex;
  justify-content: center;
  margin-bottom: 10px;
  flex-wrap: nowrap;
  padding: 0 37.5px;
  gap: 10px;
}

.lucky-number-ball {
  width: 45px;
  height: 45px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 18px;
  color: white;
  position: relative;
  box-shadow: 0 5px 10px rgba(0, 0, 0, 0.15);
  transition: transform 0.3s ease;
}

.lucky-number-ball:active {
  transform: scale(0.95);
}

.red-ball {
  background: linear-gradient(135deg, #f44336 0%, #e53935 100%);
}

.blue-ball {
  background: linear-gradient(135deg, #2196f3 0%, #1976d2 100%);
}

.lucky-star {
  position: absolute;
  top: -10px;
  right: -5px;
  font-size: 20px;
  animation: twinkle 2s infinite;
}

@keyframes twinkle {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.lucky-tip {
  font-size: 12px;
  color: #ff9800;
  font-style: italic;
  margin-top: 10px;
}

.lucky-actions {
  display: flex;
  gap: 10px;
}

.refresh-btn {
  flex: 1;
  height: 40px;
  border-radius: 20px;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7.5px;
  transition: all 0.3s ease;
  background: linear-gradient(135deg, #bbdefb 0%, #90caf9 100%);
  color: #1976d2;
  cursor: pointer;
}

.refresh-btn:active {
  opacity: 0.8;
  transform: translateY(1px);
}

.btn-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

/* AI Prediction Section */
.lottery-type-selector {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}

.type-btn {
  flex: 1;
  background: #f5f5f5;
  border-radius: 8px;
  padding: 15px 10px;
  text-align: center;
  border: 1.5px solid transparent;
  transition: all 0.3s ease;
  cursor: pointer;
}

.type-btn.active {
  background: #e8eaf6;
  border-color: #3949ab;
  transform: translateY(-2.5px);
  box-shadow: 0 5px 10px rgba(57, 73, 171, 0.15);
}

.type-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 7.5px;
  object-fit: contain;
}

.type-name {
  font-size: 15px;
  font-weight: bold;
  color: #ea7575;
}

.prediction-result {
  background: #f8f9fa;
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 20px;
  border: 1px solid #e0e0e0;
}

.result-header {
  text-align: center;
  margin-bottom: 15px;
}

.result-title {
  font-size: 17px;
  font-weight: bold;
  color: #1a237e;
  margin-bottom: 5px;
}

.result-subtitle {
  font-size: 12px;
  color: #666;
}

.prediction-numbers {
  margin-bottom: 15px;
}

.prediction-label {
  font-size: 13px;
  color: #666;
  margin-bottom: 7.5px;
  margin-top: 10px;
}

.prediction-numbers-display {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
}

.prediction-number-ball {
  width: 35px;
  height: 35px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 16px;
  color: white;
  box-shadow: 0 4px 7.5px rgba(0, 0, 0, 0.1);
}

.prediction-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.predict-btn {
  width: 100%;
  height: 48px;
  background: linear-gradient(135deg, #1a237e 0%, #283593 100%);
  color: white;
  border-radius: 24px;
  font-size: 16px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 5px 15px rgba(26, 35, 126, 0.3);
  transition: all 0.3s ease;
  cursor: pointer;
}

.predict-btn.predicting {
  opacity: 0.8;
  cursor: not-allowed;
}

.predict-btn:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.predict-btn:active:not(.predicting) {
  transform: translateY(2px);
  box-shadow: 0 2px 5px rgba(26, 35, 126, 0.3);
}

.clear-btn {
  background: transparent;
  color: #999;
  font-size: 14px;
  text-decoration: underline;
  cursor: pointer;
}

.advanced-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}

.secondary-action-btn {
  min-height: 38px;
  border-radius: 8px;
  background: #f3f5fb;
  color: #283593;
  font-size: 13px;
  font-weight: bold;
  border: 1px solid #d8ddf2;
  cursor: pointer;
}

.secondary-action-btn:disabled {
  color: #999;
  background: #f5f5f5;
  border-color: #eee;
}

.bundle-result,
.backtest-result {
  margin-top: 15px;
  border-top: 1px dashed #e6e8f2;
  padding-top: 12px;
}

.mini-section-title {
  font-size: 14px;
  font-weight: bold;
  color: #333;
  margin-bottom: 10px;
}

.bundle-item {
  border: 1px solid #edf0f7;
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 8px;
  background: #fafbff;
}

.bundle-header,
.strategy-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: #666;
  margin-bottom: 8px;
}

.bundle-header span:first-child,
.strategy-row span:first-child {
  color: #333;
  font-weight: bold;
  white-space: nowrap;
}

.compact-numbers {
  justify-content: flex-start;
}

.backtest-summary {
  background: #eef7f0;
  color: #2e7d32;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 8px;
}

.btn-content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: white;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 免责声明 */
.disclaimer {
  background: #fff3e0;
  border-radius: 12px;
  padding: 10px;
  border-left: 6px solid #ff9800;
  margin-top: 20px;
}

.disclaimer-title {
  font-size: 16px;
  font-weight: bold;
  color: #e65100;
  margin: 0;
  margin-bottom: 6px;
}

.disclaimer-content {
  font-size: 12px;
  color: #666;
  line-height: 1.6;
  margin: 0;
}

/* Floating Buttons */
.floating-buttons {
  position: fixed;
  bottom: 30px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 15px;
  z-index: 100;
}

.floating-btn {
  width: 45px;
  height: 45px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.2s;
}

.floating-btn image,
.floating-btn img {
  width: 24px;
  height: 24px;
}

.floating-btn:active {
  transform: scale(0.9);
}

/* Compound Styles (Updated) */
.options-container {
  margin-bottom: 20px;
}

.switch-container {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f5f5f5;
  padding: 12px 15px;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.05);
}

.switch-container:active {
  background: #eeeeee;
  transform: scale(0.99);
}

.switch-label-text {
  display: flex;
  flex-direction: column;
}

.main-text {
  font-size: 15px;
  font-weight: bold;
  color: #333;
}

.sub-text {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}

/* Toggle Switch CSS */
.switch {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

/* Mode Selection Styles */
.mode-selection {
  margin-bottom: 20px;
}

.mode-tabs {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.mode-chip {
  flex: 1;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 10px 5px;
  text-align: center;
  transition: all 0.2s;
  cursor: pointer;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.mode-chip.active {
  background: #e8eaf6;
  border-color: #3949ab;
  color: #1a237e;
  box-shadow: 0 4px 8px rgba(26, 35, 126, 0.15);
  transform: translateY(-2px);
}

.chip-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.chip-label {
  font-size: 13px;
  font-weight: bold;
}

.chip-cost {
  font-size: 11px;
  color: #888;
}

.mode-chip.active .chip-cost {
  color: #5c6bc0;
}

.result-footer-tag {
  margin-top: 15px;
  padding-top: 10px;
  border-top: 1px dashed #eee;
  font-size: 12px;
  color: #666;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.tag-icon {
  font-size: 14px;
}

.empty-mode-state {
  text-align: center;
  padding: 30px 10px;
  color: #888;
}
.sub-empty {
  font-size: 12px;
  color: #aaa;
  margin-top: 5px;
}

.small-ball {
  width: 28px;
  height: 28px;
  font-size: 13px;
}

/* Utility */
.hidden {
  display: none !important;
}

/* Compound Tag Styles */
.compound-tag {
  display: inline-block;
  font-size: 10px;
  background-color: #ffc107; /* Amber */
  color: #333;
  padding: 1px 4px;
  border-radius: 4px;
  margin-left: 6px;
  vertical-align: middle;
  font-weight: bold;
}
.compound-info {
  display: inline-block;
  font-size: 10px;
  color: #666;
  margin-left: 2px;
  vertical-align: middle;
}
</style>
