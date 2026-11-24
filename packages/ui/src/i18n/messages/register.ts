export const messages = {
    "zh-CN": {
        register: {
            title: "注册",
            email: "邮箱",
            username: "用户名",
            usernameHint: "可选，留空则根据邮箱自动生成",
            usernameRule: "英文字母 / 中文汉字 / 数字，且不能以数字开头",
            usernameInvalid:
                "用户名只能使用英文字母、中文汉字或数字，不能以数字开头、不能含空格，最长 32 位（例如 zhangsan / 王小明）",
            password: "密码",
            confirmPassword: "确认密码",
            submit: "注册",
            submitting: "注册中…",
            entering: "正在进入工作区…",
            rateLimited: "尝试过于频繁，请稍后再试",
            rateLimitedSeconds: "尝试过于频繁，请 {seconds} 秒后再试",
            navigationFailed: "无法进入工作区，请重试",
            login: "登录",
        },
    },
    "en-US": {
        register: {
            title: "Register",
            email: "Email",
            username: "Username",
            usernameHint: "Optional; left blank one is derived from your email",
            usernameRule: "letters / Chinese characters / digits, not starting with a digit",
            usernameInvalid:
                "Username may only use letters, Chinese characters or digits, must not start with a digit or contain spaces, and is at most 32 characters (e.g. zhangsan / 王小明)",
            password: "Password",
            confirmPassword: "Confirm Password",
            submit: "Register",
            submitting: "Registering…",
            entering: "Opening workspace…",
            rateLimited: "Too many attempts. Please try again later.",
            rateLimitedSeconds: "Too many attempts. Try again in {seconds}s.",
            navigationFailed: "Could not open the workspace. Please retry.",
            login: "Login",
        },
    },
};
