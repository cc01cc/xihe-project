export const messages = {
    "zh-CN": {
        // task-758：认证面（登录/注册/首装）的本地化错误文案。
        // 主文案永远不出现后端英文 detail；码单独渲染，原文只进可展开的技术详情。
        authErrors: {
            invalidCredentials: "邮箱/用户名或密码不正确",
            rateLimited: "尝试过于频繁，请稍后再试",
            usernameInvalid:
                "用户名格式不正确：仅英文字母/中文汉字/数字，不能以数字开头或含空格，最长 32 位",
            usernameTaken: "该用户名已被占用，请换一个",
            emailTaken: "该邮箱已注册，请直接登录或使用其他邮箱",
            invalidRequest: "提交的信息不完整或格式不正确，请检查后重试",
            firstRunUnavailable: "首启管理员账号不可用，请返回登录页或联系管理员",
            firstRunDisclosed: "首启口令已披露或账号已改写，无法再次查看",
            loginFailed: "登录失败，请稍后重试；若持续失败请联系管理员",
            registerFailed: "注册失败，请稍后重试；若持续失败请联系管理员",
            technicalDetails: "技术详情",
        },
    },
    "en-US": {
        // task-758: localized auth-surface copy. The raw backend detail never enters the
        // primary copy; the stable code renders separately and the detail sits in a disclosure.
        authErrors: {
            invalidCredentials: "Incorrect email/username or password",
            rateLimited: "Too many attempts. Please try again later.",
            usernameInvalid:
                "Invalid username: use letters, Chinese characters or digits, do not start with a digit, no spaces, max 32 characters",
            usernameTaken: "That username is taken; choose another",
            emailTaken: "That email is already registered; sign in or use another email",
            invalidRequest: "Some fields are missing or invalid; check and retry",
            firstRunUnavailable:
                "The first-run administrator account is unavailable; return to login or contact your administrator",
            firstRunDisclosed:
                "The first-run password was already disclosed or the account was rewritten; it cannot be shown again",
            loginFailed:
                "Sign-in failed. Retry in a moment; contact your administrator if it persists",
            registerFailed:
                "Registration failed. Retry in a moment; contact your administrator if it persists",
            technicalDetails: "Technical details",
        },
    },
};
