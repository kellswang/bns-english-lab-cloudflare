import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import LoginView from './views/LoginView.vue'
import WorkbenchView from './views/WorkbenchView.vue'

// 单页工作台：不再有审核、统计等下一级页面
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/', name: 'workbench', component: WorkbenchView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.ready()
  if (!auth.user && to.name !== 'login') {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }
  if (auth.user && to.name === 'login') return { name: 'workbench' }
  return true
})
