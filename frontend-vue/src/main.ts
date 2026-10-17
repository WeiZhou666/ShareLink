import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
// 暗色模式变量：html.dark 时生效（App.vue 负责切换 class）
import "element-plus/theme-chalk/dark/css-vars.css";
// 设计 token：必须在 EP 两份 CSS 之后 import——
// 我们的暗色段用 :root.dark(特异度 0,2,0) 压过 EP 的 html.dark(0,1,1)
import "./styles/tokens.css";
import App from "./App.vue";
import { router } from "./router";
import "./styles/global.css";

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus);

app.mount("#app");
