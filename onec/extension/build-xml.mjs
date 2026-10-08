// Writes the PlatformAPI extension as Configurator XML files (onec/extension/xml) from the BSL in src/.
// Load them in the Configurator: Конфигурация → Расширения конфигурации → PlatformAPI →
// Конфигурация ▾ → Загрузить конфигурацию из файлов… → this folder, then F7. See README.md.
//
//   node onec/extension/build-xml.mjs
//
// The extension is portable: it borrows nothing from the configuration (only the root and the
// language, without IDs, as every extension must) and maps by names, so the same files load into any
// base. The UUIDs below are fixed: loading a newer version keeps the PlatformLog catalog and its data.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "xml");

/** Format of the files: old enough for every 8.3 platform the configuration runs on; newer ones read it. */
const FORMAT = "2.10";
const BOM = String.fromCharCode(0xfeff);
const BOM_AT_START = new RegExp(`^${BOM}`);

const NS = [
  'xmlns="http://v8.1c.ru/8.3/MDClasses"',
  'xmlns:app="http://v8.1c.ru/8.2/managed-application/core"',
  'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"',
  'xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi"',
  'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise"',
  'xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform"',
  'xmlns:style="http://v8.1c.ru/8.1/data/ui/style"',
  'xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system"',
  'xmlns:v8="http://v8.1c.ru/8.1/data/core"',
  'xmlns:v8ui="http://v8.1c.ru/8.1/data/ui"',
  'xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web"',
  'xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows"',
  'xmlns:xen="http://v8.1c.ru/8.3/xcf/enums"',
  'xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef"',
  'xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"',
  'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
].join(" ");

const ID = {
  configuration: "972f5f00-20e3-4778-9226-c15d44f98460",
  contained: [
    ["9cd510cd-abfc-11d4-9434-004095e12fc7", "e488442a-79e5-4727-9075-0ffc3b979d82"],
    ["9fcd25a0-4822-11d4-9414-008048da11f9", "1480c48e-78cf-4dd5-98d7-b3976ea85105"],
    ["e3687481-0a87-462c-a166-9f34594f9bba", "c03ef5aa-5b78-493c-ac01-0584e88a01f9"],
    ["9de14907-ec23-4a07-96f0-85521cb6b53b", "42e5f85f-addf-4f72-876c-8906d0c89186"],
    ["51f2d5d8-ea4d-4064-8892-82951750031e", "7feec84a-4f4d-4ab2-9db0-f8bdaf2fdbfe"],
    ["e68182ea-4237-4383-967f-90c1e3370bc7", "cc3b8e91-c468-40f6-a665-444984ded46d"],
    ["fb282519-d103-4dd3-bc12-cb271d631dfc", "2ff53413-3564-40fb-b228-e391b544529b"],
  ],
  language: "9bb3756c-d7f6-472f-af57-d400ca0bc2fb",
  modules: {
    PlatformAPI: "feeed1be-d436-4273-a6b3-96dfccc910a2",
    PlatformAPI_Map: "902d16f3-5254-4348-af99-75672ec783e9",
    PlatformAPI_Log: "cd38334b-3e08-45aa-97b8-3ada00f00b68",
  },
  catalog: "3f9d4883-a094-4d65-9346-ea826a5cb00a",
  catalogTypes: {
    Object: ["dee1cde1-61a6-4893-9b2c-1dfb2c475c77", "49e55b61-fa17-4a50-9c87-a0ce562c80c5"],
    Ref: ["b9be1b71-b9d2-4c31-b45c-0fcb94bac2ea", "6bf05e3a-3fdd-4716-a338-539a37002fb0"],
    Selection: ["edb39db4-d2ea-4b2b-915c-6c2fac1f6ea5", "a1122104-da4f-4ebe-b4d3-ed541173c0da"],
    List: ["4a7cdc2d-0108-48de-8ed0-071a806218c7", "edf0fcb6-5ea9-4c10-bc16-5afeebcad38b"],
    Manager: ["bfd8005f-9914-4837-8ab0-21d5370cb056", "892bb73e-2344-4bc7-a1aa-990903fd3798"],
  },
  attributes: {
    Source: "c5b7eb4f-f235-479f-96e7-b9477e2dc306",
    ExternalID: "630f934e-d3f4-4d21-ab78-1f19a918b137",
    DocumentType: "13907a83-44e2-4476-8942-8800f4224b95",
    DocumentID: "7dfa38ed-0f08-460d-a5c8-e65c193a23f8",
    DocumentPresentation: "30701462-d2e8-4341-8630-9565b819524f",
    Details: "a3f995fa-f410-4a05-bf1d-04fa3e36368b",
    Operation: "084d5489-8162-4986-ab50-e2c9e6b0a21b",
    UserName: "812dad67-70bd-49d6-a876-b10b87632f60",
    CreatedAt: "7a83191b-abba-4319-9a0e-d1eb6122ebb2",
  },
};

/**
 * Common modules: name, synonym, privileged. Extensions may not have privileged modules (the
 * Configurator refuses them), so PlatformAPI_Log turns privileged mode on in its own code.
 */
const MODULES = [
  ["PlatformAPI", "Platform API", false],
  ["PlatformAPI_Map", "Platform API: карта имён", false],
  ["PlatformAPI_Log", "Platform API: журнал", false],
];

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const text = (value, indent) =>
  value
    ? `\n${indent}\t<v8:item>\n${indent}\t\t<v8:lang>ru</v8:lang>\n${indent}\t\t<v8:content>${esc(value)}</v8:content>\n${indent}\t</v8:item>\n${indent}`
    : "";
const doc = (body) =>
  `${BOM}<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject ${NS} version="${FORMAT}">\n${body}</MetaDataObject>`;

function write(path, content) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content.replaceAll("\n", "\r\n"));
}

const version = /Функция ВерсияРасширения\(\) Экспорт\s+Возврат "([^"]+)"/.exec(
  readFileSync(join(here, "src/CommonModules/PlatformAPI_Map.bsl"), "utf8"),
)?.[1];
if (!version) throw new Error("PlatformAPI_Map.ВерсияРасширения() not found");

function configuration() {
  const contained = ID.contained
    .map(
      ([cls, obj]) =>
        `\t\t\t<xr:ContainedObject>\n\t\t\t\t<xr:ClassId>${cls}</xr:ClassId>\n\t\t\t\t<xr:ObjectId>${obj}</xr:ObjectId>\n\t\t\t</xr:ContainedObject>\n`,
    )
    .join("");
  const children = [
    "\t\t\t<Language>Русский</Language>",
    ...MODULES.map(([name]) => `\t\t\t<CommonModule>${name}</CommonModule>`),
    "\t\t\t<Catalog>PlatformLog</Catalog>",
  ].join("\n");
  return doc(`\t<Configuration uuid="${ID.configuration}">
		<InternalInfo>
${contained}		</InternalInfo>
		<Properties>
			<ObjectBelonging>Adopted</ObjectBelonging>
			<Name>PlatformAPI</Name>
			<Synonym>${text("Platform API", "\t\t\t")}</Synonym>
			<Comment/>
			<ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>
			<KeepMappingToExtendedConfigurationObjectsByIDs>false</KeepMappingToExtendedConfigurationObjectsByIDs>
			<NamePrefix/>
			<ConfigurationExtensionCompatibilityMode>Version8_3_12</ConfigurationExtensionCompatibilityMode>
			<DefaultRunMode>ManagedApplication</DefaultRunMode>
			<UsePurposes>
				<v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>
			</UsePurposes>
			<ScriptVariant>Russian</ScriptVariant>
			<DefaultRoles/>
			<Vendor>1C Platform</Vendor>
			<Version>${version}</Version>
			<BriefInformation>${text("Platform API: обмен данными с приложением 1C Platform", "\t\t\t")}</BriefInformation>
			<DetailedInformation/>
			<Copyright/>
			<VendorInformationAddress/>
			<ConfigurationInformationAddress/>
		</Properties>
		<ChildObjects>
${children}
		</ChildObjects>
	</Configuration>
`);
}

function language() {
  return doc(`\t<Language uuid="${ID.language}">
		<InternalInfo/>
		<Properties>
			<ObjectBelonging>Adopted</ObjectBelonging>
			<Name>Русский</Name>
			<Comment/>
			<LanguageCode>ru</LanguageCode>
		</Properties>
	</Language>
`);
}

function commonModule(name, synonym, privileged) {
  return doc(`\t<CommonModule uuid="${ID.modules[name]}">
		<Properties>
			<Name>${name}</Name>
			<Synonym>${text(synonym, "\t\t\t")}</Synonym>
			<Comment/>
			<Global>false</Global>
			<ClientManagedApplication>false</ClientManagedApplication>
			<Server>true</Server>
			<ExternalConnection>true</ExternalConnection>
			<ClientOrdinaryApplication>false</ClientOrdinaryApplication>
			<ServerCall>false</ServerCall>
			<Privileged>${privileged}</Privileged>
			<ReturnValuesReuse>DontUse</ReturnValuesReuse>
		</Properties>
	</CommonModule>
`);
}

const string = (length) =>
  `<v8:Type>xs:string</v8:Type>\n\t\t\t\t\t\t<v8:StringQualifiers>\n\t\t\t\t\t\t\t<v8:Length>${length}</v8:Length>\n\t\t\t\t\t\t\t<v8:AllowedLength>Variable</v8:AllowedLength>\n\t\t\t\t\t\t</v8:StringQualifiers>`;

/**
 * PlatformLog's attributes: name, synonym, type, indexed (README.md "Catalog PlatformLog"). The
 * document is kept as its kind and UUID: extensions may not use "any document" types, and a type of
 * the configuration's own document would have to be borrowed.
 */
const ATTRIBUTES = [
  ["Source", "Источник", string(50), false],
  ["ExternalID", "Внешний ID", string(100), true],
  ["DocumentType", "Вид документа", string(100), false],
  ["DocumentID", "УИД документа", string(36), false],
  ["DocumentPresentation", "Документ", string(150), false],
  ["Details", "Подробности (JSON)", string(0), false],
  ["Operation", "Операция", string(50), false],
  ["UserName", "Пользователь", string(100), false],
  [
    "CreatedAt",
    "Создано",
    "<v8:Type>xs:dateTime</v8:Type>\n\t\t\t\t\t\t<v8:DateQualifiers>\n\t\t\t\t\t\t\t<v8:DateFractions>DateTime</v8:DateFractions>\n\t\t\t\t\t\t</v8:DateQualifiers>",
    false,
  ],
];

function attribute([name, synonym, type, indexed]) {
  return `\t\t\t<Attribute uuid="${ID.attributes[name]}">
				<Properties>
					<Name>${name}</Name>
					<Synonym>${text(synonym, "\t\t\t\t\t")}</Synonym>
					<Comment/>
					<Type>
						${type}
					</Type>
					<PasswordMode>false</PasswordMode>
					<Format/>
					<EditFormat/>
					<ToolTip/>
					<MarkNegatives>false</MarkNegatives>
					<Mask/>
					<MultiLine>false</MultiLine>
					<ExtendedEdit>false</ExtendedEdit>
					<MinValue xsi:nil="true"/>
					<MaxValue xsi:nil="true"/>
					<FillFromFillingValue>false</FillFromFillingValue>
					<FillValue xsi:nil="true"/>
					<FillChecking>DontCheck</FillChecking>
					<ChoiceFoldersAndItems>Items</ChoiceFoldersAndItems>
					<ChoiceParameterLinks/>
					<ChoiceParameters/>
					<QuickChoice>Auto</QuickChoice>
					<CreateOnInput>Auto</CreateOnInput>
					<ChoiceForm/>
					<LinkByType/>
					<ChoiceHistoryOnInput>Auto</ChoiceHistoryOnInput>
					<Use>ForItem</Use>
					<Indexing>${indexed ? "Index" : "DontIndex"}</Indexing>
					<FullTextSearch>DontUse</FullTextSearch>
					<DataHistory>DontUse</DataHistory>
				</Properties>
			</Attribute>
`;
}

function catalog() {
  const types = Object.entries(ID.catalogTypes)
    .map(
      ([category, [typeId, valueId]]) =>
        `\t\t\t<xr:GeneratedType name="Catalog${category}.PlatformLog" category="${category}">\n\t\t\t\t<xr:TypeId>${typeId}</xr:TypeId>\n\t\t\t\t<xr:ValueId>${valueId}</xr:ValueId>\n\t\t\t</xr:GeneratedType>\n`,
    )
    .join("");
  return doc(`\t<Catalog uuid="${ID.catalog}">
		<InternalInfo>
${types}		</InternalInfo>
		<Properties>
			<Name>PlatformLog</Name>
			<Synonym>${text("Журнал Platform API", "\t\t\t")}</Synonym>
			<Comment/>
			<Hierarchical>false</Hierarchical>
			<HierarchyType>HierarchyFoldersAndItems</HierarchyType>
			<LimitLevelCount>false</LimitLevelCount>
			<LevelCount>2</LevelCount>
			<FoldersOnTop>true</FoldersOnTop>
			<UseStandardCommands>true</UseStandardCommands>
			<Owners/>
			<SubordinationUse>ToItems</SubordinationUse>
			<CodeLength>0</CodeLength>
			<DescriptionLength>150</DescriptionLength>
			<CodeType>String</CodeType>
			<CodeAllowedLength>Variable</CodeAllowedLength>
			<CodeSeries>WholeCatalog</CodeSeries>
			<CheckUnique>false</CheckUnique>
			<Autonumbering>false</Autonumbering>
			<DefaultPresentation>AsDescription</DefaultPresentation>
			<Characteristics/>
			<PredefinedDataUpdate>Auto</PredefinedDataUpdate>
			<EditType>InDialog</EditType>
			<QuickChoice>false</QuickChoice>
			<ChoiceMode>BothWays</ChoiceMode>
			<InputByString>
				<xr:Field>Catalog.PlatformLog.StandardAttribute.Description</xr:Field>
			</InputByString>
			<SearchStringModeOnInputByString>Begin</SearchStringModeOnInputByString>
			<FullTextSearchOnInputByString>DontUse</FullTextSearchOnInputByString>
			<ChoiceDataGetModeOnInputByString>Directly</ChoiceDataGetModeOnInputByString>
			<DefaultObjectForm/>
			<DefaultFolderForm/>
			<DefaultListForm/>
			<DefaultChoiceForm/>
			<DefaultFolderChoiceForm/>
			<AuxiliaryObjectForm/>
			<AuxiliaryFolderForm/>
			<AuxiliaryListForm/>
			<AuxiliaryChoiceForm/>
			<AuxiliaryFolderChoiceForm/>
			<IncludeHelpInContents>false</IncludeHelpInContents>
			<BasedOn/>
			<DataLockFields/>
			<DataLockControlMode>Managed</DataLockControlMode>
			<FullTextSearch>DontUse</FullTextSearch>
			<ObjectPresentation>${text("Запись журнала Platform API", "\t\t\t")}</ObjectPresentation>
			<ExtendedObjectPresentation/>
			<ListPresentation/>
			<ExtendedListPresentation/>
			<Explanation/>
			<CreateOnInput>DontUse</CreateOnInput>
			<ChoiceHistoryOnInput>Auto</ChoiceHistoryOnInput>
			<DataHistory>DontUse</DataHistory>
			<UpdateDataHistoryImmediatelyAfterWrite>false</UpdateDataHistoryImmediatelyAfterWrite>
			<ExecuteAfterWriteDataHistoryVersionProcessing>false</ExecuteAfterWriteDataHistoryVersionProcessing>
		</Properties>
		<ChildObjects>
${ATTRIBUTES.map(attribute).join("")}		</ChildObjects>
	</Catalog>
`);
}

rmSync(out, { recursive: true, force: true });
write("Configuration.xml", configuration());
write("Languages/Русский.xml", language());
for (const [name, synonym, privileged] of MODULES) {
  write(`CommonModules/${name}.xml`, commonModule(name, synonym, privileged));
  const bsl = readFileSync(join(here, `src/CommonModules/${name}.bsl`), "utf8").replace(BOM_AT_START, "");
  write(`CommonModules/${name}/Ext/Module.bsl`, BOM + bsl);
}
write("Catalogs/PlatformLog.xml", catalog());
console.log(`PlatformAPI ${version} → ${out}`);
