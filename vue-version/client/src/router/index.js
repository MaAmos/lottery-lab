import { createRouter, createWebHistory } from "vue-router";
import Home from "../views/Research.vue";
import History from "../views/History.vue";

const routes = [
  {
    path: "/",
    name: "Home",
    component: Home,
  },
  {
    path: "/history",
    name: "History",
    component: History,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
