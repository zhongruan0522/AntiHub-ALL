--
-- PostgreSQL database dump
--

-- Dumped from database version 18.1
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: get_user_shared_cookie_count(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.get_user_shared_cookie_count(p_user_id character varying) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)
    FROM accounts
    WHERE user_id::TEXT = p_user_id::TEXT
      AND is_shared = 1
      AND status = 1
  );
END;
$$;




--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;




--
-- Name: update_user_shared_quota_max(character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.update_user_shared_quota_max(p_user_id character varying, p_model_name character varying) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_cookie_count INTEGER;
  v_new_max NUMERIC(10,4);
BEGIN
  -- 获取用户有效的共享cookie数量
  v_cookie_count := get_user_shared_cookie_count(p_user_id);
  
  -- 计算新的上限?? * n
  v_new_max := 2.0 * v_cookie_count;
  
  -- 更新或插入配额池记录
  -- 只更??max_quota，不更新 quota
  INSERT INTO user_shared_quota_pool (user_id, model_name, quota, max_quota)
  VALUES (p_user_id::UUID, p_model_name, v_new_max, v_new_max)
  ON CONFLICT (user_id, model_name)
  DO UPDATE SET
    max_quota = v_new_max,
    last_updated_at = CURRENT_TIMESTAMP;
END;
$$;




--
-- Name: FUNCTION update_user_shared_quota_max(p_user_id character varying, p_model_name character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_user_shared_quota_max(p_user_id character varying, p_model_name character varying) IS '更新用户共享配额池的 max_quota（基于用户共享账号数量计算）。此函数主要用于 scripts/update-user-quotas.js 脚本同步配额。添??删除账号时的 quota 更新??JavaScript 代码处理??';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    cookie_id character varying(255) NOT NULL,
    user_id uuid NOT NULL,
    is_shared smallint DEFAULT 0 NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    expires_at bigint,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    need_refresh boolean DEFAULT false NOT NULL,
    name character varying(100),
    email character varying(255),
    project_id_0 character varying(255) DEFAULT ''::character varying,
    is_restricted boolean DEFAULT false NOT NULL,
    paid_tier boolean,
    ineligible boolean DEFAULT false NOT NULL
);




--
-- Name: TABLE accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.accounts IS '用户账号??';


--
-- Name: COLUMN accounts.cookie_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.cookie_id IS 'Cookie的唯一标识（主键）';


--
-- Name: COLUMN accounts.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.user_id IS '用户UUID（外键关联users表）';


--
-- Name: COLUMN accounts.is_shared; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.is_shared IS 'Cookie共享标识: 0=专属, 1=共享';


--
-- Name: COLUMN accounts.access_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.access_token IS '访问令牌';


--
-- Name: COLUMN accounts.refresh_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.refresh_token IS '刷新令牌';


--
-- Name: COLUMN accounts.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.expires_at IS '令牌过期时间（时间戳，毫秒）';


--
-- Name: COLUMN accounts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.status IS '账号状?? 0=禁用, 1=启用';


--
-- Name: COLUMN accounts.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.created_at IS '创建时间';


--
-- Name: COLUMN accounts.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.updated_at IS '更新时间';


--
-- Name: COLUMN accounts.need_refresh; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.need_refresh IS '是否需要重新刷新token: true=需要用户重新授?? false=正常';


--
-- Name: COLUMN accounts.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.name IS '账号名称（用户自定义??';


--
-- Name: COLUMN accounts.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.email IS '账号邮箱（Google账号邮箱，用于防止重复添加）';


--
-- Name: COLUMN accounts.project_id_0; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.project_id_0 IS 'Google Cloud项目ID（从API获取??';


--
-- Name: COLUMN accounts.is_restricted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.is_restricted IS '是否受地区限?? false=不受?? true=受限';


--
-- Name: COLUMN accounts.paid_tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.paid_tier IS '是否付费用户: true=付费, false=免费（默认）';


--
-- Name: COLUMN accounts.ineligible; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.ineligible IS '账号是否不合?? false=合格, true=不合??INELIGIBLE_ACCOUNT)';


--
-- Name: kiro_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kiro_accounts (
    account_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    account_name character varying(100),
    auth_method character varying(20) NOT NULL,
    refresh_token text NOT NULL,
    access_token text,
    expires_at bigint,
    client_id text,
    client_secret text,
    profile_arn text,
    machineid text NOT NULL,
    region character varying(32) DEFAULT 'us-east-1' NOT NULL,
    is_shared smallint DEFAULT 0 NOT NULL,
    email character varying(255),
    userid text NOT NULL,
    subscription text NOT NULL,
    current_usage double precision NOT NULL,
    reset_date text NOT NULL,
    free_trial_status boolean NOT NULL,
    free_trial_usage double precision,
    free_trial_expiry text,
    free_trial_limit double precision NOT NULL,
    usage_limit double precision NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    need_refresh boolean DEFAULT false NOT NULL,
    bonus_usage double precision DEFAULT 0,
    bonus_limit double precision DEFAULT 0,
    bonus_available double precision DEFAULT 0,
    bonus_details jsonb DEFAULT '[]'::jsonb,
    CONSTRAINT kiro_accounts_auth_method_check CHECK (((auth_method)::text = ANY ((ARRAY['Social'::character varying, 'IdC'::character varying, ''::character varying])::text[]))),
    CONSTRAINT kiro_accounts_is_shared_check CHECK ((is_shared = ANY (ARRAY[0, 1]))),
    CONSTRAINT kiro_accounts_status_check CHECK ((status = ANY (ARRAY[0, 1])))
);




--
-- Name: TABLE kiro_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.kiro_accounts IS 'Kiro账号表（独立系统??';


--
-- Name: COLUMN kiro_accounts.account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.account_id IS '账号UUID（主键）';


--
-- Name: COLUMN kiro_accounts.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.user_id IS '用户UUID（外键关联users表）';


--
-- Name: COLUMN kiro_accounts.account_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.account_name IS '账号名称（用户自定义??';


--
-- Name: COLUMN kiro_accounts.auth_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.auth_method IS '认证方式: Social, IdC';


--
-- Name: COLUMN kiro_accounts.refresh_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.refresh_token IS '刷新令牌';


--
-- Name: COLUMN kiro_accounts.access_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.access_token IS '访问令牌';


--
-- Name: COLUMN kiro_accounts.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.expires_at IS '令牌过期时间（时间戳，毫秒）';


--
-- Name: COLUMN kiro_accounts.client_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.client_id IS 'IdC认证的client_id';


--
-- Name: COLUMN kiro_accounts.client_secret; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.client_secret IS 'IdC认证的client_secret';


--
-- Name: COLUMN kiro_accounts.profile_arn; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.profile_arn IS 'Social认证的profile_arn';


--
-- Name: COLUMN kiro_accounts.machineid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.machineid IS '机器ID（必填）';


--
-- Name: COLUMN kiro_accounts.region; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.region IS 'AWS 区域ID（默??us-east-1??';


--
-- Name: COLUMN kiro_accounts.is_shared; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.is_shared IS 'Cookie共享标识: 0=专属, 1=共享（必填）';


--
-- Name: COLUMN kiro_accounts.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.email IS '账号邮箱（可选）';


--
-- Name: COLUMN kiro_accounts.userid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.userid IS '用户ID标识（必填）';


--
-- Name: COLUMN kiro_accounts.subscription; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.subscription IS '当前订阅（必填）';


--
-- Name: COLUMN kiro_accounts.current_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.current_usage IS '当前使用量（必填??';


--
-- Name: COLUMN kiro_accounts.reset_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.reset_date IS '重置日期（必填）';


--
-- Name: COLUMN kiro_accounts.free_trial_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.free_trial_status IS '免费试用状态（必填??';


--
-- Name: COLUMN kiro_accounts.free_trial_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.free_trial_usage IS '免费试用使用量（可选）';


--
-- Name: COLUMN kiro_accounts.free_trial_expiry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.free_trial_expiry IS '免费试用过期时间（可选）';


--
-- Name: COLUMN kiro_accounts.free_trial_limit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.free_trial_limit IS '免费试用限额（必填）';


--
-- Name: COLUMN kiro_accounts.usage_limit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.usage_limit IS '使用限额（必填）';


--
-- Name: COLUMN kiro_accounts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.status IS '账号状?? 0=禁用, 1=启用';


--
-- Name: COLUMN kiro_accounts.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.created_at IS '创建时间';


--
-- Name: COLUMN kiro_accounts.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.updated_at IS '更新时间';


--
-- Name: COLUMN kiro_accounts.need_refresh; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.need_refresh IS '是否需要重新刷新token: true=需要用户重新授?? false=正常';


--
-- Name: COLUMN kiro_accounts.bonus_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.bonus_usage IS 'Bonus总使用量（包含免费试用和bonus??';


--
-- Name: COLUMN kiro_accounts.bonus_limit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.bonus_limit IS 'Bonus总限额（包含免费试用和bonus??';


--
-- Name: COLUMN kiro_accounts.bonus_available; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.bonus_available IS 'Bonus可用额度（包含免费试用和bonus??';


--
-- Name: COLUMN kiro_accounts.bonus_details; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_accounts.bonus_details IS 'Bonus详情（JSON数组，包含每个bonus的详细信息）';


--
-- Name: kiro_consumption_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kiro_consumption_log (
    log_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    account_id uuid NOT NULL,
    model_id character varying(100) NOT NULL,
    credit_used numeric(10,4) NOT NULL,
    is_shared smallint DEFAULT 0 NOT NULL,
    consumed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT kiro_consumption_log_is_shared_check CHECK ((is_shared = ANY (ARRAY[0, 1])))
);




--
-- Name: TABLE kiro_consumption_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.kiro_consumption_log IS 'Kiro消费日志表：记录每次对话的credit消??';


--
-- Name: COLUMN kiro_consumption_log.log_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.log_id IS '日志ID（主键）';


--
-- Name: COLUMN kiro_consumption_log.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.user_id IS '用户ID';


--
-- Name: COLUMN kiro_consumption_log.account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.account_id IS 'Kiro账号ID';


--
-- Name: COLUMN kiro_consumption_log.model_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.model_id IS '模型ID';


--
-- Name: COLUMN kiro_consumption_log.credit_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.credit_used IS '消耗的credit（保??位小数）';


--
-- Name: COLUMN kiro_consumption_log.is_shared; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.is_shared IS '是否使用共享账号??=共享??=专属??';


--
-- Name: COLUMN kiro_consumption_log.consumed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kiro_consumption_log.consumed_at IS '消耗时??';


--
-- Name: model_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_quotas (
    quota_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    cookie_id character varying(255) NOT NULL,
    model_name character varying(100) NOT NULL,
    reset_time timestamp without time zone,
    quota numeric(5,4) DEFAULT 1.0000 NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    last_fetched_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);




--
-- Name: TABLE model_quotas; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.model_quotas IS '模型配额??';


--
-- Name: COLUMN model_quotas.quota_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.quota_id IS '配额UUID（主键）';


--
-- Name: COLUMN model_quotas.cookie_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.cookie_id IS 'Cookie ID（外键关联accounts表）';


--
-- Name: COLUMN model_quotas.model_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.model_name IS '模型名称';


--
-- Name: COLUMN model_quotas.reset_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.reset_time IS '配额重置时间';


--
-- Name: COLUMN model_quotas.quota; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.quota IS '剩余配额比例??.0000-1.0000??';


--
-- Name: COLUMN model_quotas.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.status IS '模型可用状?? 0=不可?? 1=可用';


--
-- Name: COLUMN model_quotas.last_fetched_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.last_fetched_at IS '最后一次fetch时间';


--
-- Name: COLUMN model_quotas.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_quotas.created_at IS '创建时间';


--
-- Name: quota_consumption_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quota_consumption_log (
    log_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    cookie_id character varying(255) NOT NULL,
    model_name character varying(100) NOT NULL,
    quota_before numeric(10,4) NOT NULL,
    quota_after numeric(10,4) NOT NULL,
    quota_consumed numeric(10,4) NOT NULL,
    is_shared smallint DEFAULT 1 NOT NULL,
    consumed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);




--
-- Name: TABLE quota_consumption_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.quota_consumption_log IS '配额消耗记录表：记录每次对话的quota消??';


--
-- Name: COLUMN quota_consumption_log.log_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.log_id IS '日志ID（主键，自增??';


--
-- Name: COLUMN quota_consumption_log.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.user_id IS '用户ID';


--
-- Name: COLUMN quota_consumption_log.cookie_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.cookie_id IS 'Cookie ID';


--
-- Name: COLUMN quota_consumption_log.model_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.model_name IS '模型名称';


--
-- Name: COLUMN quota_consumption_log.quota_before; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.quota_before IS '对话开始前的cookie quota';


--
-- Name: COLUMN quota_consumption_log.quota_after; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.quota_after IS '对话结束后的cookie quota';


--
-- Name: COLUMN quota_consumption_log.quota_consumed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.quota_consumed IS '消耗的quota（quota_before - quota_after??';


--
-- Name: COLUMN quota_consumption_log.is_shared; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.is_shared IS '是否使用共享cookie??=共享??=专属??';


--
-- Name: COLUMN quota_consumption_log.consumed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quota_consumption_log.consumed_at IS '消耗时??';


--
-- Name: shared_pool_quotas_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.shared_pool_quotas_view AS
 SELECT mq.model_name,
    sum(mq.quota) AS total_quota,
    min(mq.reset_time) AS earliest_reset_time,
    count(DISTINCT mq.cookie_id) AS available_cookies,
        CASE
            WHEN (sum(mq.quota) > (0)::numeric) THEN 1
            ELSE 0
        END AS status,
    max(mq.last_fetched_at) AS last_fetched_at
   FROM (public.model_quotas mq
     JOIN public.accounts a ON (((mq.cookie_id)::text = (a.cookie_id)::text)))
  WHERE ((a.is_shared = 1) AND (a.status = 1) AND (mq.status = 1))
  GROUP BY mq.model_name;




--
-- Name: VIEW shared_pool_quotas_view; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.shared_pool_quotas_view IS '共享池配额视图：聚合所有共享cookie的配额总和';


--
-- Name: user_shared_quota_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_shared_quota_pool (
    pool_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    model_name character varying(100) NOT NULL,
    quota numeric(10,4) DEFAULT 0.0000 NOT NULL,
    max_quota numeric(10,4) DEFAULT 0.0000 NOT NULL,
    last_recovered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);




--
-- Name: TABLE user_shared_quota_pool; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_shared_quota_pool IS '用户共享配额池：用于使用共享cookie时扣??';


--
-- Name: COLUMN user_shared_quota_pool.pool_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.pool_id IS '配额池ID（主键，自增??';


--
-- Name: COLUMN user_shared_quota_pool.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.user_id IS '用户ID';


--
-- Name: COLUMN user_shared_quota_pool.model_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.model_name IS '模型名称';


--
-- Name: COLUMN user_shared_quota_pool.quota; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.quota IS '当前配额';


--
-- Name: COLUMN user_shared_quota_pool.max_quota; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.max_quota IS '配额上限??*n，n为用户共享cookie数）';


--
-- Name: COLUMN user_shared_quota_pool.last_recovered_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.last_recovered_at IS '最后恢复时??';


--
-- Name: COLUMN user_shared_quota_pool.last_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_shared_quota_pool.last_updated_at IS '最后更新时??';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    api_key character varying(64) NOT NULL,
    name character varying(100),
    prefer_shared smallint DEFAULT 0 NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);




--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS '用户??';


--
-- Name: COLUMN users.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.user_id IS '用户UUID（主键）';


--
-- Name: COLUMN users.api_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.api_key IS 'API Key（sk-xxx格式，唯一??';


--
-- Name: COLUMN users.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.name IS '用户名称';


--
-- Name: COLUMN users.prefer_shared; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.prefer_shared IS 'Cookie优先?? 0=专属优先, 1=共享优先';


--
-- Name: COLUMN users.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.status IS '用户状?? 0=禁用, 1=启用';


--
-- Name: COLUMN users.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.created_at IS '创建时间';


--
-- Name: COLUMN users.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.updated_at IS '更新时间';


--
-- Name: qwen_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qwen_accounts (
    account_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    account_name character varying(100),
    is_shared smallint DEFAULT 0 NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    expires_at bigint,
    last_refresh text,
    resource_url character varying(255) DEFAULT 'portal.qwen.ai'::character varying,
    email character varying(255),
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    need_refresh boolean DEFAULT false NOT NULL,
    CONSTRAINT qwen_accounts_is_shared_check CHECK ((is_shared = ANY (ARRAY[0, 1]))),
    CONSTRAINT qwen_accounts_status_check CHECK ((status = ANY (ARRAY[0, 1])))
);




--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (cookie_id);


--
-- Name: kiro_accounts kiro_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kiro_accounts
    ADD CONSTRAINT kiro_accounts_pkey PRIMARY KEY (account_id);

--
-- Name: qwen_accounts qwen_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qwen_accounts
    ADD CONSTRAINT qwen_accounts_pkey PRIMARY KEY (account_id);


--
-- Name: kiro_consumption_log kiro_consumption_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kiro_consumption_log
    ADD CONSTRAINT kiro_consumption_log_pkey PRIMARY KEY (log_id);


--
-- Name: model_quotas model_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_quotas
    ADD CONSTRAINT model_quotas_pkey PRIMARY KEY (quota_id);


--
-- Name: quota_consumption_log quota_consumption_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_consumption_log
    ADD CONSTRAINT quota_consumption_log_pkey PRIMARY KEY (log_id);


--
-- Name: model_quotas uk_cookie_model; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_quotas
    ADD CONSTRAINT uk_cookie_model UNIQUE (cookie_id, model_name);


--
-- Name: user_shared_quota_pool uk_user_shared_model; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_shared_quota_pool
    ADD CONSTRAINT uk_user_shared_model UNIQUE (user_id, model_name);


--
-- Name: user_shared_quota_pool user_shared_quota_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_shared_quota_pool
    ADD CONSTRAINT user_shared_quota_pool_pkey PRIMARY KEY (pool_id);


--
-- Name: users users_api_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_api_key_key UNIQUE (api_key);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: idx_accounts_ineligible; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_ineligible ON public.accounts USING btree (ineligible);


--
-- Name: idx_accounts_is_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_is_shared ON public.accounts USING btree (is_shared);


--
-- Name: idx_accounts_need_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_need_refresh ON public.accounts USING btree (need_refresh);


--
-- Name: idx_accounts_paid_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_paid_tier ON public.accounts USING btree (paid_tier);


--
-- Name: idx_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_status ON public.accounts USING btree (status);


--
-- Name: idx_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_user_id ON public.accounts USING btree (user_id);


--
-- Name: idx_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_accounts_email ON public.accounts USING btree (email) WHERE (email IS NOT NULL);


--
-- Name: idx_kiro_accounts_auth_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_auth_method ON public.kiro_accounts USING btree (auth_method);


--
-- Name: idx_kiro_accounts_bonus_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_bonus_available ON public.kiro_accounts USING btree (bonus_available);


--
-- Name: idx_kiro_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_email ON public.kiro_accounts USING btree (email);


--
-- Name: idx_kiro_accounts_is_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_is_shared ON public.kiro_accounts USING btree (is_shared);


--
-- Name: idx_kiro_accounts_need_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_need_refresh ON public.kiro_accounts USING btree (need_refresh);


--
-- Name: idx_kiro_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_status ON public.kiro_accounts USING btree (status);


--
-- Name: idx_kiro_accounts_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_subscription ON public.kiro_accounts USING btree (subscription);


--
-- Name: idx_kiro_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_user_id ON public.kiro_accounts USING btree (user_id);


--
-- Name: idx_kiro_accounts_userid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_accounts_userid ON public.kiro_accounts USING btree (userid);

--
-- Name: idx_qwen_accounts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_qwen_accounts_email ON public.qwen_accounts USING btree (email) WHERE (email IS NOT NULL);

--
-- Name: idx_qwen_accounts_is_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qwen_accounts_is_shared ON public.qwen_accounts USING btree (is_shared);

--
-- Name: idx_qwen_accounts_need_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qwen_accounts_need_refresh ON public.qwen_accounts USING btree (need_refresh);

--
-- Name: idx_qwen_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qwen_accounts_status ON public.qwen_accounts USING btree (status);

--
-- Name: idx_qwen_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qwen_accounts_user_id ON public.qwen_accounts USING btree (user_id);


--
-- Name: idx_kiro_consumption_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_consumption_account_id ON public.kiro_consumption_log USING btree (account_id);


--
-- Name: idx_kiro_consumption_consumed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_consumption_consumed_at ON public.kiro_consumption_log USING btree (consumed_at);


--
-- Name: idx_kiro_consumption_is_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_consumption_is_shared ON public.kiro_consumption_log USING btree (is_shared);


--
-- Name: idx_kiro_consumption_model_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_consumption_model_id ON public.kiro_consumption_log USING btree (model_id);


--
-- Name: idx_kiro_consumption_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kiro_consumption_user_id ON public.kiro_consumption_log USING btree (user_id);


--
-- Name: idx_model_quotas_cookie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_quotas_cookie_id ON public.model_quotas USING btree (cookie_id);


--
-- Name: idx_model_quotas_model_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_quotas_model_name ON public.model_quotas USING btree (model_name);


--
-- Name: idx_model_quotas_reset_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_quotas_reset_time ON public.model_quotas USING btree (reset_time);


--
-- Name: idx_model_quotas_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_quotas_status ON public.model_quotas USING btree (status);


--
-- Name: idx_quota_consumption_consumed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_consumption_consumed_at ON public.quota_consumption_log USING btree (consumed_at);


--
-- Name: idx_quota_consumption_cookie_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_consumption_cookie_id ON public.quota_consumption_log USING btree (cookie_id);


--
-- Name: idx_quota_consumption_is_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_consumption_is_shared ON public.quota_consumption_log USING btree (is_shared);


--
-- Name: idx_quota_consumption_model_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_consumption_model_name ON public.quota_consumption_log USING btree (model_name);


--
-- Name: idx_quota_consumption_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_consumption_user_id ON public.quota_consumption_log USING btree (user_id);


--
-- Name: idx_user_shared_quota_pool_model_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_shared_quota_pool_model_name ON public.user_shared_quota_pool USING btree (model_name);


--
-- Name: idx_user_shared_quota_pool_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_shared_quota_pool_user_id ON public.user_shared_quota_pool USING btree (user_id);


--
-- Name: idx_users_api_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_api_key ON public.users USING btree (api_key);


--
-- Name: idx_users_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_status ON public.users USING btree (status);


--
-- Name: accounts update_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: kiro_accounts update_kiro_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_kiro_accounts_updated_at BEFORE UPDATE ON public.kiro_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

--
-- Name: qwen_accounts update_qwen_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_qwen_accounts_updated_at BEFORE UPDATE ON public.qwen_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: accounts fk_account_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT fk_account_user FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: quota_consumption_log fk_consumption_cookie; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_consumption_log
    ADD CONSTRAINT fk_consumption_cookie FOREIGN KEY (cookie_id) REFERENCES public.accounts(cookie_id) ON DELETE CASCADE;


--
-- Name: quota_consumption_log fk_consumption_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_consumption_log
    ADD CONSTRAINT fk_consumption_user FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: model_quotas fk_quota_cookie; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_quotas
    ADD CONSTRAINT fk_quota_cookie FOREIGN KEY (cookie_id) REFERENCES public.accounts(cookie_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_shared_quota_pool fk_shared_pool_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_shared_quota_pool
    ADD CONSTRAINT fk_shared_pool_user FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: kiro_accounts kiro_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kiro_accounts
    ADD CONSTRAINT kiro_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

--
-- Name: qwen_accounts qwen_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qwen_accounts
    ADD CONSTRAINT qwen_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: kiro_consumption_log kiro_consumption_log_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kiro_consumption_log
    ADD CONSTRAINT kiro_consumption_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.kiro_accounts(account_id) ON DELETE CASCADE;


--
-- Name: kiro_consumption_log kiro_consumption_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kiro_consumption_log
    ADD CONSTRAINT kiro_consumption_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: kiro_subscription_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kiro_subscription_models (
    subscription text NOT NULL,
    allowed_model_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT kiro_subscription_models_pkey PRIMARY KEY (subscription)
);




--
-- PostgreSQL database dump complete
--
-- PostgreSQL database dump complete
--

