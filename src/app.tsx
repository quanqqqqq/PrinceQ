/**
 * 路由表。
 *
 * 首页是落地页，保持静态导入——它必须和首屏 chunk 一起到达，不能先闪一下
 * 加载态。其余业务页走 `React.lazy`，各自切出独立 chunk；`/matrix` 依赖
 * ECharts（约 1MB），静态导入会把它压进首屏，所以这里必须是动态的。
 */
import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import HomePage from '@/pages/HomePage/HomePage';

const MatrixPage = lazy(() => import('@/pages/MatrixPage/MatrixPage'));
const GoalsPage = lazy(() => import('@/pages/GoalsPage/GoalsPage'));
const ActivityPage = lazy(() => import('@/pages/ActivityPage/ActivityPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage/SettingsPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage/NotFoundPage'));

/** 页面级加载态：只占一行，不跳动布局。 */
function PageFallback() {
  return (
    <p role="status" className="px-1 py-16 text-center text-xs text-muted-foreground">
      正在加载页面…
    </p>
  );
}

/** 每个懒加载路由共用同一个 Suspense 边界包装。 */
const lazyRoute = (element: React.ReactNode) => (
  <Suspense fallback={<PageFallback />}>{element}</Suspense>
);

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="/matrix" element={lazyRoute(<MatrixPage />)} />
        <Route path="/goals" element={lazyRoute(<GoalsPage />)} />
        <Route path="/activity" element={lazyRoute(<ActivityPage />)} />
        <Route path="/settings" element={lazyRoute(<SettingsPage />)} />
        <Route path="*" element={lazyRoute(<NotFoundPage />)} />
      </Route>
    </Routes>
  );
}
