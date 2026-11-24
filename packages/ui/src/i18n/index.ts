import { createI18n } from "vue-i18n";
import { messages as errorsMessages } from "./messages/errors";
import { messages as authErrorsMessages } from "./messages/authErrors";
import { messages as userQuestionsMessages } from "./messages/userQuestions";
import { messages as teamBoardMessages } from "./messages/teamBoard";
import { messages as steerMessages } from "./messages/steer";
import { messages as navMessages } from "./messages/nav";
import { messages as tabsMessages } from "./messages/tabs";
import { messages as filesMessages } from "./messages/files";
import { messages as orgMembersMessages } from "./messages/orgMembers";
import { messages as workspaceNavMessages } from "./messages/workspaceNav";
import { messages as standaloneChatMessages } from "./messages/standaloneChat";
import { messages as standaloneDialogMessages } from "./messages/standaloneDialog";
import { messages as sidebarMessages } from "./messages/sidebar";
import { messages as monitorMessages } from "./messages/monitor";
import { messages as workspacePickerMessages } from "./messages/workspacePicker";
import { messages as workspaceMessages } from "./messages/workspace";
import { messages as workspaceAgentsMessages } from "./messages/workspaceAgents";
import { messages as chatMessages } from "./messages/chat";
import { messages as resourcesMessages } from "./messages/resources";
import { messages as knowledgeMessages } from "./messages/knowledge";
import { messages as settingsMessages } from "./messages/settings";
import { messages as multimodalMessages } from "./messages/multimodal";
import { messages as validationMessages } from "./messages/validation";
import { messages as commonMessages } from "./messages/common";
import { messages as loginMessages } from "./messages/login";
import { messages as registerMessages } from "./messages/register";
import { messages as onboardingMessages } from "./messages/onboarding";
import { messages as agentBindingsMessages } from "./messages/agentBindings";
import { messages as agentPrincipalsMessages } from "./messages/agentPrincipals";
import { messages as agentPrincipalDetailMessages } from "./messages/agentPrincipalDetail";
import { messages as credentialsMessages } from "./messages/credentials";
import { messages as sessionSettingsMessages } from "./messages/sessionSettings";

export const messages = {
    "zh-CN": {
        ...errorsMessages["zh-CN"],
        ...authErrorsMessages["zh-CN"],
        ...userQuestionsMessages["zh-CN"],
        ...teamBoardMessages["zh-CN"],
        ...steerMessages["zh-CN"],
        ...navMessages["zh-CN"],
        ...tabsMessages["zh-CN"],
        ...filesMessages["zh-CN"],
        ...orgMembersMessages["zh-CN"],
        ...workspaceNavMessages["zh-CN"],
        ...standaloneChatMessages["zh-CN"],
        ...standaloneDialogMessages["zh-CN"],
        ...sidebarMessages["zh-CN"],
        ...monitorMessages["zh-CN"],
        ...workspacePickerMessages["zh-CN"],
        ...workspaceMessages["zh-CN"],
        ...workspaceAgentsMessages["zh-CN"],
        ...chatMessages["zh-CN"],
        ...resourcesMessages["zh-CN"],
        ...knowledgeMessages["zh-CN"],
        ...settingsMessages["zh-CN"],
        ...multimodalMessages["zh-CN"],
        ...validationMessages["zh-CN"],
        ...commonMessages["zh-CN"],
        ...loginMessages["zh-CN"],
        ...registerMessages["zh-CN"],
        ...onboardingMessages["zh-CN"],
        ...agentBindingsMessages["zh-CN"],
        ...agentPrincipalsMessages["zh-CN"],
        ...agentPrincipalDetailMessages["zh-CN"],
        ...credentialsMessages["zh-CN"],
        ...sessionSettingsMessages["zh-CN"],
    },
    "en-US": {
        ...errorsMessages["en-US"],
        ...authErrorsMessages["en-US"],
        ...userQuestionsMessages["en-US"],
        ...teamBoardMessages["en-US"],
        ...steerMessages["en-US"],
        ...navMessages["en-US"],
        ...tabsMessages["en-US"],
        ...filesMessages["en-US"],
        ...orgMembersMessages["en-US"],
        ...workspaceNavMessages["en-US"],
        ...standaloneChatMessages["en-US"],
        ...standaloneDialogMessages["en-US"],
        ...sidebarMessages["en-US"],
        ...monitorMessages["en-US"],
        ...workspacePickerMessages["en-US"],
        ...workspaceMessages["en-US"],
        ...workspaceAgentsMessages["en-US"],
        ...chatMessages["en-US"],
        ...resourcesMessages["en-US"],
        ...knowledgeMessages["en-US"],
        ...settingsMessages["en-US"],
        ...multimodalMessages["en-US"],
        ...validationMessages["en-US"],
        ...commonMessages["en-US"],
        ...loginMessages["en-US"],
        ...registerMessages["en-US"],
        ...onboardingMessages["en-US"],
        ...agentBindingsMessages["en-US"],
        ...agentPrincipalsMessages["en-US"],
        ...agentPrincipalDetailMessages["en-US"],
        ...credentialsMessages["en-US"],
        ...sessionSettingsMessages["en-US"],
    },
};

export const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en-US",
    messages,
});
