<template>
  <div class="container">
    <div class="page-header">
      <h1 class="title">历史预测记录</h1>
      <p class="subtitle">查看所有历史生成的号码及开奖详情</p>
    </div>

    <!-- Filter Tabs -->
    <div class="filter-tabs">
      <div
        class="tab-item"
        :class="{ active: currentTab === 'all' }"
        @click="switchTab('all')"
      >
        全网记录
      </div>
      <div
        class="tab-item"
        :class="{ active: currentTab === 'mine' }"
        @click="switchTab('mine')"
      >
        我的记录
      </div>
    </div>

    <div class="history-list" v-if="historyList.length > 0">
      <div
        class="history-item"
        :class="{
          'hit-item': item.hit_count > 0,
          'miss-item': item.hit_count === 0 && item.red_lottery_nums.length > 0,
        }"
        v-for="(item, index) in historyList"
        :key="index"
      >
        <div class="history-header">
          <div class="issue-info">
            {{ item.lottery_type === "ssq" ? "双色球" : "大乐透" }}
            <!-- 动态判断是否为复式 -->
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
            <template v-if="item.hit_detail">
              <span class="hit-detail-text"
                >红:{{ item.hit_detail.red }} 蓝:{{
                  item.hit_detail.blue
                }}</span
              >
            </template>
            <template v-else>
              {{ item.hit_count > 0 ? `命中${item.hit_count}个` : "未中奖" }}
            </template>
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
                class="number-ball predicted red-ball"
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
                    item.red_lottery_nums && item.red_lottery_nums.includes(num)
                  "
                >
                  ✓
                </div>
              </span>
              <!-- 蓝球预测 -->
              <span
                v-for="num in item.blue_predicted_nums"
                :key="'p-b-' + num"
                class="number-ball predicted blue-ball"
                :class="{
                  'hit-ball':
                    item.blue_lottery_nums &&
                    item.blue_lottery_nums.includes(num),
                }"
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

          <div class="vs-text" v-if="item.red_lottery_nums.length > 0">VS</div>

          <div class="numbers-group" v-if="item.red_lottery_nums.length > 0">
            <div class="numbers-label">开奖号码</div>
            <div class="numbers-display">
              <span
                v-for="num in item.red_lottery_nums"
                :key="'l-r-' + num"
                class="number-ball lottery red-ball"
                >{{ num }}</span
              >
              <span
                v-for="num in item.blue_lottery_nums"
                :key="'l-b-' + num"
                class="number-ball lottery blue-ball"
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
      <!-- Load More Button -->
      <div class="load-more" v-if="hasMore">
        <button @click="loadMore" :disabled="loading">
          {{ loading ? "加载中..." : "加载更多" }}
        </button>
      </div>
      <div class="no-more" v-else-if="historyList.length > 0">
        没有更多记录了
      </div>
    </div>
    <van-empty v-else description="暂无历史记录" />

    <div class="back-home">
      <button @click="$router.push('/')">返回首页</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api";
import { showToast } from "vant";

const historyList = ref([]);
const page = ref(1);
const limit = 20;
const hasMore = ref(true);
const loading = ref(false);
const currentTab = ref("all");

const loadHistory = async () => {
  if (loading.value) return;
  loading.value = true;
  try {
    const mode = currentTab.value === "mine" ? "mine" : "all";
    const res = await api.getHistory({
      limit: limit,
      page: page.value,
      mode: mode,
    });
    if (res.data.success) {
      const newData = res.data.data.history.data;
      if (newData.length < limit) {
        hasMore.value = false;
      }
      if (page.value === 1) {
        historyList.value = newData;
      } else {
        historyList.value = [...historyList.value, ...newData];
      }
      page.value++;
    }
  } catch (e) {
    console.error(e);
    showToast("获取历史记录失败");
  } finally {
    loading.value = false;
  }
};

const switchTab = (tab) => {
  if (currentTab.value === tab) return;
  currentTab.value = tab;
  // Reset Data
  historyList.value = [];
  page.value = 1;
  hasMore.value = true;
  loadHistory();
};

const loadMore = () => {
  loadHistory();
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

onMounted(() => {
  loadHistory();
});
</script>

<style>
/* ... existing styles ... */
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
/* Reusing styles from Home.vue or defining necessary ones */
.load-more {
  text-align: center;
  padding: 20px 0 100px;
}
.load-more button {
  background: #1976d2;
  color: white;
  padding: 10px 20px;
  border-radius: 20px;
  font-size: 14px;
}
.load-more button:disabled {
  background: #ccc;
}
.no-more {
  text-align: center;
  color: #999;
  padding: 20px 20px 100px;
  font-size: 13px;
}
.back-home {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  width: 100%;
  display: flex;
  justify-content: center;
  pointer-events: none; /* Allows clicking through the container area */
}
.back-home button {
  pointer-events: auto;
  background: linear-gradient(135deg, #1a237e 0%, #283593 100%);
  color: white;
  padding: 12px 30px;
  border-radius: 30px;
  font-size: 15px;
  font-weight: 600;
  box-shadow: 0 4px 15px rgba(26, 35, 126, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(5px);
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 6px;
}

.back-home button:active {
  transform: scale(0.95);
  box-shadow: 0 2px 8px rgba(26, 35, 126, 0.2);
}

.back-home button::before {
  content: "←";
  font-size: 18px;
  line-height: 1;
  margin-right: 2px;
}

/* Tab Styles */
.filter-tabs {
  display: flex;
  background: #e8eaf6;
  padding: 4px;
  margin: 0 0 20px;
  border-radius: 12px;
  position: relative;
  z-index: 1;
}

.tab-item {
  flex: 1;
  text-align: center;
  padding: 12px 0;
  font-size: 15px;
  color: #7986cb;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  font-weight: 500;
  position: relative;
  z-index: 2;
}

.tab-item.active {
  background: #ffffff;
  color: #1a237e;
  font-weight: bold;
  box-shadow: 0 2px 8px rgba(26, 35, 126, 0.15);
  transform: scale(1.02);
}
</style>

<style scoped>
/* History List */
.history-list {
  display: flex;
  flex-direction: column;
  gap: 12.5px;
  overflow-y: scroll;
  max-height: 100%;
}

.hit-detail-text {
  font-weight: bold;
  font-size: 13px;
}

/* History Numbers Style */
.numbers-comparison {
  margin-bottom: 12px;
}

.numbers-group {
  margin-bottom: 6px;
}
.numbers-label {
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}
.numbers-display {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.number-ball {
  width: 20px;
  height: 20px;
  line-height: 20px;
  border-radius: 50%;
  text-align: center;
  margin-right: 3px;
  margin-bottom: 3px;
  font-size: 12px; /* 字体适中 */
  font-weight: bold;
  position: relative;
  display: inline-block;
  box-sizing: border-box;
  color: #fff !important; /* 全局白字 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15); /* 增加投影 */
}

/* --- 基础红蓝球样式 (Home.vue 同款渐变) --- */

.red-ball {
  background: linear-gradient(135deg, #f44336 0%, #e53935 100%) !important;
  border: none !important;
}

.blue-ball {
  background: linear-gradient(135deg, #2196f3 0%, #1976d2 100%) !important;
  border: none !important;
}

/* --- 预测号码状态区分 --- */

/* 未命中的预测球：稍微淡一点，突出命中的球 */
.predicted.red-ball:not(.hit-ball) {
  opacity: 0.7;
  background: linear-gradient(
    135deg,
    #ef9a9a 0%,
    #e57373 100%
  ) !important; /* 浅红实心 */
}

.predicted.blue-ball:not(.hit-ball) {
  opacity: 0.7;
  background: linear-gradient(
    135deg,
    #90caf9 0%,
    #64b5f6 100%
  ) !important; /* 浅蓝实心 */
}

/* 命中的球：保持鲜艳，加金色边框强调 */
.hit-ball {
  opacity: 1 !important;
  transform: scale(1.05); /* 微微放大 */
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  z-index: 1;
}

/* --- 开奖号码样式 (权威感) --- */
.lottery.red-ball {
  background: linear-gradient(
    135deg,
    #d32f2f 0%,
    #b71c1c 100%
  ) !important; /* 深红 */
}
.lottery.blue-ball {
  background: linear-gradient(
    135deg,
    #1976d2 0%,
    #0d47a1 100%
  ) !important; /* 深蓝 */
}

/* 命中角标 */
.hit-indicator {
  position: absolute;
  top: -3px;
  right: -3px;
  color: #d32f2f;
  background: #fff;
  border: 1px solid #ffcdd2;
  border-radius: 50%;
  width: 12px;
  height: 12px;
  line-height: 10px; /* 微调对齐 */
  text-align: center;
  font-size: 10px;
  font-weight: 900;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  z-index: 2;
}
</style>
