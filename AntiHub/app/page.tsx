'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import ColourfulText from '@/components/ui/colourful-text';
import {
  IconRocket,
  IconShield,
  IconBolt,
  IconServer,
  IconChartBar,
  IconKey,
  IconArrowRight,
  IconBrandGithub,
  IconSparkles
} from '@tabler/icons-react';
import Hyperspeed from '@/components/Hyperspeed';
import { hyperspeedPresets } from '@/lib/hyperspeed-presets';
import { ChatGLM, Claude, Gemini, Qwen, OpenAI, Zhipu, Anthropic } from '@lobehub/icons';
import { Header } from '@/components/ui/header-1';
import { ShinyButton } from "@/components/ui/shiny-button";
import { isAuthenticated } from '@/lib/api';
import { motion, useScroll, useTransform } from 'framer-motion';

// 滚动动画组件
function ScrollSection({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"]
  });

  const opacity = useTransform(scrollYProgress, [0, 0.3, 0.7, 1], [0, 1, 1, 0]);
  const y = useTransform(scrollYProgress, [0, 0.3, 0.7, 1], [50, 0, 0, -50]);

  return (
    <motion.div
      ref={ref}
      style={{ opacity, y }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    setIsLoggedIn(isAuthenticated());
  }, []);

  const heroRef = useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll();
  const heroOpacity = useTransform(scrollY, [0, 300], [1, 0]);
  const heroY = useTransform(scrollY, [0, 300], [0, -150]);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <Header />

      {/* Hero Section with Hyperspeed Background */}
      <motion.section
        ref={heroRef}
        style={{ opacity: heroOpacity, y: heroY }}
        className="relative h-[calc(100vh-4rem)] flex items-center justify-center overflow-hidden"
      >
        {/* Hyperspeed Background */}
        <div className="absolute inset-0 z-0">
          <Hyperspeed effectOptions={hyperspeedPresets.one as any} />
        </div>

        {/* Hero Content */}
        <div className="relative z-10 mx-auto max-w-7xl px-4 md:px-6 lg:px-8 py-20 md:py-32">
          <div className="flex flex-col items-center text-center space-y-8">
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold tracking-tight max-w-4xl text-white">
              管理你的 AI 账号
              <br />
              释放<ColourfulText text="无限可能" />
            </h1>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 lg:gap-12 mt-16 w-full max-w-4xl">
              <div className="space-y-2">
                <div className="text-3xl md:text-4xl font-bold text-white">10+</div>
                <div className="text-sm text-gray-400">AI 模型</div>
              </div>
              <div className="space-y-2">
                <div className="text-3xl md:text-4xl font-bold text-white">1000+</div>
                <div className="text-sm text-gray-400">活跃用户</div>
              </div>
              <div className="space-y-2">
                <div className="text-3xl md:text-4xl font-bold text-white">99.9%</div>
                <div className="text-sm text-gray-400">可用性</div>
              </div>
              <div className="space-y-2">
                <div className="text-3xl md:text-4xl font-bold text-white">24/7</div>
                <div className="text-sm text-gray-400">技术支持</div>
              </div>
            </div>
          </div>
        </div>
      </motion.section>

      {/* Logo Section - 合作伙伴 & 提供模型 */}
      <ScrollSection className="relative min-h-screen bg-black flex items-center py-20">
        <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8 w-full">
          {/* 合作伙伴 */}
          <div className="mb-20">
            <p className="text-center text-lg text-white mb-12 font-semibold">深受合作伙伴信任</p>
            <div className="flex justify-center items-center gap-12 md:gap-20 flex-wrap">
              <div className="flex flex-col items-center gap-3">
                <OpenAI className="size-16 text-white" />
                <span className="text-sm text-gray-400">OpenAI</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Gemini className="size-16 text-white" />
                <span className="text-sm text-gray-400">Google Gemini</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Anthropic className="size-16 text-white" />
                <span className="text-sm text-gray-400">Anthropic</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Zhipu className="size-16 text-white" />
                <span className="text-sm text-gray-400">智谱 AI</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Qwen className="size-16 text-white" />
                <span className="text-sm text-gray-400">Qwen</span>
              </div>
            </div>
          </div>

          {/* 分隔线 */}
          <div className="max-w-md mx-auto mb-20">
            <div className="h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
          </div>

          {/* 提供模型 */}
          <div>
            <p className="text-center text-lg text-white mb-12 font-semibold">提供模型</p>
            <div className="flex justify-center items-center gap-12 md:gap-20 flex-wrap">
              <div className="flex flex-col items-center gap-3">
                <ChatGLM className="size-16 text-white" />
                <span className="text-sm text-gray-400">智谱 ChatGLM</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Claude className="size-16 text-white" />
                <span className="text-sm text-gray-400">Anthropic Claude</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Gemini className="size-16 text-white" />
                <span className="text-sm text-gray-400">Google Gemini</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <OpenAI className="size-16 text-white" />
                <span className="text-sm text-gray-400">OpenAI ChatGPT</span>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Qwen className="size-16 text-white" />
                <span className="text-sm text-gray-400">Qwen</span>
              </div>
            </div>
          </div>
        </div>
      </ScrollSection>

      {/* Features Section */}
      <ScrollSection className="relative bg-gradient-to-b from-black via-gray-900/50 to-black py-20 md:py-32">
        <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8">
          <div className="text-center space-y-4 mb-16">
            <Badge variant="secondary" className="px-4 py-1.5 bg-white/10 border-white/20 text-white">功能特性</Badge>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
              为什么选择 AntiHub
            </h2>
            <p className="text-lg text-gray-400 max-w-2xl mx-auto">
              我们提供简洁可靠的 AI 账号与配额管理体验
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <CardSpotlight>
              <div className="size-12 rounded-lg bg-white/10 flex items-center justify-center mb-4">
                <IconRocket className="size-6 text-white" />
              </div>
              <p className="text-xl font-bold relative z-20 mb-2 text-white">
                快速部署
              </p>
              <p className="text-neutral-300 mt-4 relative z-20 text-sm">
                一键接入多个 AI 模型，无需复杂配置，即刻开始使用
              </p>
            </CardSpotlight>

            <CardSpotlight>
              <div className="size-12 rounded-lg bg-white/10 flex items-center justify-center mb-4">
                <IconShield className="size-6 text-white" />
              </div>
              <p className="text-xl font-bold relative z-20 mb-2 text-white">
                安全可靠
              </p>
              <p className="text-neutral-300 mt-4 relative z-20 text-sm">
                企业级安全保障，数据加密传输，保护您的隐私和数据安全
              </p>
            </CardSpotlight>

            <CardSpotlight>
              <div className="size-12 rounded-lg bg-white/10 flex items-center justify-center mb-4">
                <IconBolt className="size-6 text-white" />
              </div>
              <p className="text-xl font-bold relative z-20 mb-2 text-white">
                高性能
              </p>
              <p className="text-neutral-300 mt-4 relative z-20 text-sm">
                优化的资源调度算法，确保最快的响应速度和最佳性能
              </p>
            </CardSpotlight>

            <CardSpotlight>
              <div className="size-12 rounded-lg bg-white/10 flex items-center justify-center mb-4">
                <IconServer className="size-6 text-white" />
              </div>
              <p className="text-xl font-bold relative z-20 mb-2 text-white">
                高可用性
              </p>
              <p className="text-neutral-300 mt-4 relative z-20 text-sm">
                多节点部署和自动故障转移，确保服务始终在线，稳定可靠
              </p>
            </CardSpotlight>

            <CardSpotlight>
              <div className="size-12 rounded-lg bg-white/10 flex items-center justify-center mb-4">
                <IconChartBar className="size-6 text-white" />
              </div>
              <p className="text-xl font-bold relative z-20 mb-2 text-white">
                实时监控
              </p>
              <p className="text-neutral-300 mt-4 relative z-20 text-sm">
                详细的使用统计和配额监控，让您随时掌握资源使用情况
              </p>
            </CardSpotlight>

            <CardSpotlight>
              <div className="size-12 rounded-lg bg-white/10 flex items-center justify-center mb-4">
                <IconKey className="size-6 text-white" />
              </div>
              <p className="text-xl font-bold relative z-20 mb-2 text-white">
                API 管理
              </p>
              <p className="text-neutral-300 mt-4 relative z-20 text-sm">
                灵活的 API Key 管理，支持多密钥，方便团队协作使用
              </p>
            </CardSpotlight>
          </div>
        </div>
      </ScrollSection>

      {/* CTA Section */}
      <ScrollSection className="relative bg-black py-20 md:py-32">
        <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8">
          <div className="bg-black/50 backdrop-blur">
            <div className="flex flex-col items-center text-center space-y-6 py-16 px-6">
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight max-w-3xl">
                准备好开始了吗？
              </h2>
              <p className="text-lg text-gray-400 max-w-2xl">
                立即注册 AntiHub，开始管理你的 AI 账号
              </p>
              <div className="flex flex-col sm:flex-row gap-4 mt-8">
                <Link href={isLoggedIn ? "/dashboard" : "/auth"}>
                  <ShinyButton>{isLoggedIn ? "进入控制台" : "获取访问权限"}</ShinyButton>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </ScrollSection>

      {/* Footer */}
      <footer className="border-t border-white/10 bg-black">
        <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8 py-12">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 lg:gap-12">
            <div className="col-span-2 sm:col-span-1">
              <div className="flex items-center gap-2 mb-4">
                <img src="/logo_dark.png" alt="AntiHub" className="h-6" />
                <span className="font-bold">AntiHub</span>
              </div>
              <p className="text-sm text-gray-400">
                管理 AI 账号，释放无限可能
              </p>
            </div>
            <div>
              <h3 className="font-semibold mb-4">产品</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><Link href="#features" className="hover:text-white transition-colors">功能特性</Link></li>
                <li><Link href="#pricing" className="hover:text-white transition-colors">价格</Link></li>
                <li><Link href="/dashboard" className="hover:text-white transition-colors">仪表板</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-4">资源</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><Link href="https://github.com/zhongruan0522/AntiHub-ALL/issues" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">社区</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-4">关于</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><Link href="https://github.com/zhongruan0522/AntiHub-ALL" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">关于我们</Link></li>
                <li><Link href="https://github.com/zhongruan0522/AntiHub-ALL/issues" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">联系我们</Link></li>
                <li><Link href="#" className="hover:text-white transition-colors">隐私政策</Link></li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-sm text-gray-400 text-center md:text-left">
              © 2025 AntiHub. All rights reserved.
            </p>
            <div className="flex items-center gap-4">
              <Link href="https://github.com/zhongruan0522/AntiHub-ALL" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition-colors">
                <IconBrandGithub className="size-5" />
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
