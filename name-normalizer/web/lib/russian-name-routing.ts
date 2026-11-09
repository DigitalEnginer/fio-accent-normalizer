const KAZAKH_SPECIFIC_LETTERS = /[әіңғүұқөһ]/u;

const COMMON_RUSSIAN_GIVEN_NAMES = new Set([
  "александр",
  "алексей",
  "анастасия",
  "андрей",
  "анна",
  "артем",
  "артём",
  "валентина",
  "виктор",
  "виктория",
  "владимир",
  "галина",
  "дмитрий",
  "евгений",
  "екатерина",
  "елена",
  "иван",
  "ирина",
  "марина",
  "мария",
  "михаил",
  "наталья",
  "николай",
  "ольга",
  "павел",
  "сергей",
  "светлана",
  "татьяна",
  "юлия",
]);

export function isLikelyRussianNameForm(value: string): boolean {
  if (KAZAKH_SPECIFIC_LETTERS.test(value) || !/^[а-яё]+$/u.test(value)) {
    return false;
  }

  return COMMON_RUSSIAN_GIVEN_NAMES.has(value);
}
