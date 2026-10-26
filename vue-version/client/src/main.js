import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import "vant/lib/index.css";
import "./assets/style.css";
import {
  Button,
  Toast,
  Dialog,
  Tabbar,
  TabbarItem,
  Icon,
  Loading,
  Empty,
} from "vant";

const app = createApp(App);

app.use(router);
app.use(Button);
app.use(Toast);
app.use(Dialog);
app.use(Tabbar);
app.use(TabbarItem);
app.use(Icon);
app.use(Loading);
app.use(Empty);

app.mount("#app");
